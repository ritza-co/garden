/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve } from "path"
import { startCase, mapValues } from "lodash"
import split2 = require("split2")

import { ConfigurationError, PluginError, RuntimeError } from "@garden-io/sdk/exceptions"
import { LogEntry, PluginContext } from "@garden-io/sdk/types"
import { dedent } from "@garden-io/sdk/util/string"
import { PulumiProvider } from "."
import { writeFile } from "fs-extra"
import chalk from "chalk"

import { joi, PrimitiveMap, joiStringMap } from "@garden-io/core/build/src/config/common"

export const variablesSchema = () => joiStringMap(joi.any())

export interface PulumiBaseSpec {
  allowDestroy: boolean
  autoApply: boolean
  dependencies: string[]
  variables: PrimitiveMap
  stack?: string
}

interface PulumiParams {
  ctx: PluginContext
  log: LogEntry
  provider: PulumiProvider
  root: string
}

interface PulumiParamsWithWorkspace extends PulumiParams {
  workspace: string | null
}

/**
 * Validates the stack at the given root.
 *
 * Note that this does not set the workspace, so it must be set ahead of calling the function.
 */
export async function tfValidate(params: PulumiParams) {
  const { log, ctx, provider, root } = params

  const args = ["validate", "-json"]
  const res = await pulumi(ctx, provider).json({
    log,
    args,
    ignoreError: true,
    cwd: root,
  })

  if (res.valid === false) {
    const reasons = res.diagnostics.map((d: any) => d.summary)

    if (
      reasons.includes("Could not satisfy plugin requirements") ||
      reasons.includes("Module not installed") ||
      reasons.includes("Could not load plugin")
    ) {
      // We need to run `pulumi init` and retry validation
      log.debug("Initializing Pulumi")
      await tfInit(params)

      const retryRes = await pulumi(ctx, provider).json({
        log,
        args,
        ignoreError: true,
        cwd: root,
      })
      if (retryRes.valid === "false") {
        throw tfValidationError(retryRes)
      }
    } else {
      throw tfValidationError(res)
    }
  }
}

export function tfValidationError(result: any) {
  const errors = result.diagnostics.map((d: any) => `${startCase(d.severity)}: ${d.summary}\n${d.detail || ""}`)
  return new ConfigurationError(dedent`Failed validating Pulumi configuration:\n\n${errors.join("\n")}`, {
    result,
  })
}

interface PulumiParamsWithVariables extends PulumiParamsWithWorkspace {
  variables: object
}

type StackStatus = "up-to-date" | "outdated" | "error"

/**
 * Checks and returns the status of a Pulumi stack.
 *
 * Note: If `autoApply` is set to `false` and the stack is not ready, we still return `ready: true` and log a warning,
 * since the user may want to manually update their stacks. The `autoApply` flag is only for information, and setting
 * it to `true` does _not_ mean this method will apply the change.
 */
export async function getStackStatus(params: PulumiParamsWithVariables): Promise<StackStatus> {
  const { ctx, log, provider, root, variables } = params

  await setWorkspace(params)
  await tfValidate(params)

  const logEntry = log.verbose({ section: "pulumi", msg: "Running plan...", status: "active" })

  const plan = await pulumi(ctx, provider).exec({
    log,
    ignoreError: true,
    args: [
      "plan",
      "-detailed-exitcode",
      "-input=false",
      // We don't refresh here, and trust the state. Users can manually run plan if they need the state refreshed.
      "-refresh=false",
      // No reason to lock the state file here since we won't modify it.
      "-lock=false",
      ...(await prepareVariables(root, variables)),
    ],
    cwd: root,
  })

  if (plan.exitCode === 0) {
    // Stack is up-to-date
    logEntry.setSuccess({ msg: chalk.green("Stack up-to-date"), append: true })
    return "up-to-date"
  } else if (plan.exitCode === 1) {
    // Error from pulumi. This can, for example, happen if variables are missing or there are errors in the tf files.
    // We ignore this here and carry on. Following commands will output the same error.
    logEntry.setError()
    return "error"
  } else if (plan.exitCode === 2) {
    // No error but stack is not up-to-date
    logEntry.setWarn({ msg: "Not up-to-date" })
    return "outdated"
  } else {
    logEntry.setError()
    throw new PluginError(`Unexpected exit code from \`pulumi plan\`: ${plan.exitCode}`, {
      exitCode: plan.exitCode,
      stderr: plan.stderr,
      stdout: plan.stdout,
    })
  }
}

export async function applyStack(params: PulumiParamsWithVariables) {
  const { ctx, log, provider, root, variables } = params

  await setWorkspace(params)

  const args = ["apply", "-auto-approve", "-input=false", ...(await prepareVariables(root, variables))]
  const proc = await pulumi(ctx, provider).spawn({ log, args, cwd: root })

  const statusLine = log.info("→ Applying Pulumi stack...")
  const logStream = split2()

  let stdout: string = ""
  let stderr: string = ""

  if (proc.stdout) {
    proc.stdout.pipe(logStream)
    proc.stdout.on("data", (data) => {
      stdout += data
    })
  }

  if (proc.stderr) {
    proc.stderr.pipe(logStream)
    proc.stderr.on("data", (data) => {
      stderr += data
    })
  }

  logStream.on("data", (line: Buffer) => {
    statusLine.setState(chalk.gray("→ " + line.toString()))
  })

  await new Promise<void>((_resolve, reject) => {
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) {
        _resolve()
      } else {
        reject(
          new RuntimeError(`Error when applying Pulumi stack:\n${stderr}`, {
            stdout,
            stderr,
            code,
          })
        )
      }
    })
  })
}

/**
 * If any variables are specified in the Garden config, this prepares a .tfvars file to use and returns the
 * appropriate arguments to pass to the Pulumi CLI, otherwise an empty array.
 */
export async function prepareVariables(targetDir: string, variables?: object): Promise<string[]> {
  if (Object.entries(variables || {}).length === 0) {
    return []
  }

  const path = resolve(targetDir, "garden.tfvars.json")
  await writeFile(path, JSON.stringify(variables))

  return ["-var-file", path]
}

/**
 * Lists the created workspaces for the given Pulumi `root`, and returns which one is selected.
 */
export async function getWorkspaces(params: PulumiParams) {
  const { ctx, log, provider, root } = params

  // Must in some cases ensure init is complete before listing workspaces
  await tfInit(params)

  const res = await pulumi(ctx, provider).stdout({ args: ["workspace", "list"], cwd: root, log })
  let selected = "default"

  const workspaces = res
    .trim()
    .split("\n")
    .map((line) => {
      let name: string

      if (line.startsWith("*")) {
        name = line.trim().slice(2)
        selected = name
      } else {
        name = line.trim()
      }

      return name
    })

  return { workspaces, selected }
}

/**
 * Sets the workspace to use in the Pulumi `root`, creating it if it doesn't already exist. Does nothing if
 * no `workspace` is set.
 */
export async function setWorkspace(params: PulumiParamsWithWorkspace) {
  const { ctx, provider, root, log, workspace } = params

  if (!workspace) {
    return
  }

  const { workspaces, selected } = await getWorkspaces(params)

  if (selected === workspace) {
    return
  }

  if (workspaces.includes(workspace)) {
    await pulumi(ctx, provider).stdout({ args: ["workspace", "select", workspace], cwd: root, log })
  } else {
    await pulumi(ctx, provider).stdout({ args: ["workspace", "new", workspace], cwd: root, log })
  }
}

export async function tfInit({ ctx, log, provider, root }: PulumiParams) {
  await pulumi(ctx, provider).exec({ log, args: ["init"], cwd: root, timeoutSec: 600 })
}
