/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { join } from "path"
import { pathExists } from "fs-extra"
import { joi } from "@garden-io/core/build/src/config/common"
import { dedent, deline } from "@garden-io/sdk/util/string"
import { supportedVersions, pulumi } from "./cli"
import { GardenModule } from "@garden-io/sdk/types"
import { ConfigurationError } from "@garden-io/sdk/exceptions"
import { dependenciesSchema } from "@garden-io/core/build/src/config/service"
import {
  getStackStatus,
  variablesSchema,
  PulumiBaseSpec,
  getTfOutputs,
  prepareVariables,
  setWorkspace,
} from "./common"
import { PulumiProvider } from "."
import { baseBuildSpecSchema } from "@garden-io/core/build/src/config/module"
import chalk from "chalk"
import { ModuleActionHandlers, ServiceActionHandlers } from "@garden-io/sdk/types"

export interface PulumiModuleSpec extends PulumiBaseSpec {
  root: string
}

export interface PulumiModule extends GardenModule<PulumiModuleSpec> {}

export const pulumiModuleSchema = () =>
  joi.object().keys({
    build: baseBuildSpecSchema(),
    allowDestroy: joi.boolean().default(false).description(dedent`
      If set to true, Garden will destroy stack when calling \`garden delete env\` or \`garden delete service <module name>\`.
    `),
    autoApply: joi.boolean().allow(null).default(false).description(dedent`
      If set to true, Garden will automatically deploy the stack is not up-to-date. Otherwise, a warning is logged if the stack is out-of-date, and an error thrown if it is missing entirely.
    `),
    dependencies: dependenciesSchema(),
    root: joi.posixPath().subPathOnly().default(".").description(dedent`
      Specify the path to the Pulumi project root, relative to the module root.
    `),
    variables: variablesSchema().description(dedent`
      A map of variables to use when applying the stack, overriding variables set in the \`Pulumi.<stack>.yaml\` file (if any).

      If you specified \`variables\` in the \`pulumi\` provider config, those will be included but the variables
      specified here take precedence.
    `),
    stack: joi.string().allow(null).description("Use the specified Pulumi stack."),
  })

export const configurePulumiModule: ModuleActionHandlers["configure"] = async ({ ctx, moduleConfig }) => {
  // Make sure the configured root path exists
  const root = moduleConfig.spec.root
  if (root) {
    const absRoot = join(moduleConfig.path, root)
    const exists = await pathExists(absRoot)

    if (!exists) {
      throw new ConfigurationError(`Pulumi: configured working directory '${root}' does not exist`, {
        moduleConfig,
      })
    }
  }

  const provider = ctx.provider as PulumiProvider

  // Use the provider config if no value is specified for the module
  if (moduleConfig.spec.autoApply === null) {
    moduleConfig.spec.autoApply = provider.config.autoApply
  }
  if (!moduleConfig.spec.version) {
    moduleConfig.spec.version = provider.config.version
  }

  moduleConfig.serviceConfigs = [
    {
      name: moduleConfig.name,
      dependencies: moduleConfig.spec.dependencies,
      disabled: false,
      hotReloadable: false,
      spec: moduleConfig.spec,
    },
  ]

  return { moduleConfig }
}

export const getPulumiStatus: ServiceActionHandlers["getServiceStatus"] = async ({
  ctx,
  log,
  module,
  service,
}) => {
  const provider = ctx.provider as PulumiProvider
  const root = getModuleStackRoot(module)
  const variables = module.spec.variables
  const workspace = module.spec.workspace || null

  const status = await getStackStatus({
    ctx,
    log,
    provider,
    root,
    variables,
    workspace,
  })

  return {
    state: status === "up-to-date" ? "ready" : "outdated",
    version: service.version,
    outputs: await getTfOutputs({ log, ctx, provider, root }),
    detail: {},
  }
}

export const deployPulumi: ServiceActionHandlers["deployService"] = async ({
  ctx,
  log,
  module,
  service,
}) => {
  const provider = ctx.provider as PulumiProvider
  const workspace = module.spec.workspace || null
  const root = getModuleStackRoot(module)

  if (module.spec.autoApply) {
    await applyStack({ log, ctx, provider, root, variables: module.spec.variables, workspace })
  } else {
    const templateKey = `\${runtime.services.${module.name}.outputs.*}`
    log.warn(
      chalk.yellow(
        deline`
        Stack is out-of-date but autoApply is set to false, so it will not be applied automatically. If any newly added
        stack outputs are referenced via ${templateKey} template strings and are missing,
        you may see errors when resolving them.
        `
      )
    )
    await setWorkspace({ log, ctx, provider, root, workspace })
  }

  return {
    state: "ready",
    version: service.version,
    outputs: await getTfOutputs({ log, ctx, provider, root }),
    detail: {},
  }
}

export const deletePulumiModule: ServiceActionHandlers["deleteService"] = async ({
  ctx,
  log,
  module,
  service,
}) => {
  const provider = ctx.provider as PulumiProvider

  if (!module.spec.allowDestroy) {
    log.warn({ section: module.name, msg: "allowDestroy is set to false. Not calling pulumi destroy." })
    return {
      state: "outdated",
      detail: {},
    }
  }

  const root = getModuleStackRoot(module)
  const variables = module.spec.variables
  const workspace = module.spec.workspace || null

  await setWorkspace({ ctx, provider, root, log, workspace })

  const args = ["destroy", "-auto-approve", "-input=false", ...(await prepareVariables(root, variables))]
  await pulumi(ctx, provider).exec({ log, args, cwd: root })

  return {
    state: "missing",
    version: service.version,
    outputs: {},
    detail: {},
  }
}

function getModuleStackRoot(module: PulumiModule) {
  return join(module.path, module.spec.root)
}
