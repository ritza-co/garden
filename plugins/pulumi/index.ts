/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { createGardenPlugin } from "@garden-io/sdk"
import { dedent } from "@garden-io/sdk/util/string"
import {
  pulumiModuleSchema,
  configurePulumiModule,
  getPulumiStatus,
  deployPulumi,
  deletePulumiModule,
} from "./module"
import { docsBaseUrl } from "@garden-io/sdk/constants"
import { getPulumiCommands } from "./commands"

import { providerConfigBaseSchema, GenericProviderConfig, Provider } from "@garden-io/core/build/src/config/provider"
import { joiVariables } from "@garden-io/core/build/src/config/common"
import { readdir } from "fs-extra"

type PulumiProviderConfig = GenericProviderConfig

export interface PulumiProvider extends Provider<PulumiProviderConfig> {}

const configSchema = providerConfigBaseSchema()
  .keys({})
  .unknown(false)

// Need to make these variables to avoid escaping issues
const serviceOutputsTemplateString = "${runtime.services.<module-name>.outputs.<key>}"
const moduleReferenceUrl = `${docsBaseUrl}/reference/module-types/pulumi`

export const gardenPlugin = () =>
  createGardenPlugin({
    name: "pulumi",
    docs: dedent`
      **EXPERIMENTAL**

      This provider allows you to integrate [Pulumi](https://pulumi.com) stacks into your Garden project, via [\`pulumi\` modules](${moduleReferenceUrl}).
    `,
    configSchema,
    commands: getPulumiCommands(),
    createModuleTypes: [
      {
        name: "pulumi",
        docs: dedent`
          Resolves a Pulumi stack and either creates/updates it automatically (if \`autoApply: true\`) or warns when the stack resources are not up-to-date, or errors if it's missing entirely.

          **Note: It is not recommended to set \`autoApply\` to \`true\` for production or shared environments, since this may result in accidental or conflicting changes to the stack.** Instead, it is recommended to manually preview and update using the provided plugin commands. Run \`garden plugins pulumi\` for details. Note that not all Pulumi CLI commands are wrapped by the plugin, only the ones where it's important to apply any variables defined in the module. For others, simply run the Pulumi CLI as usual from the project root.

          Stack outputs are made available as service outputs, that can be referenced by other modules under \`${serviceOutputsTemplateString}\`. You can template in those values as e.g. command arguments or environment variables for other services.

          See the [Pulumi guide](${docsBaseUrl}/advanced/pulumi) for a high-level introduction to the \`pulumi\` provider.
        `,
        serviceOutputsSchema: joiVariables().description("A map of all the outputs returned by the Pulumi stack."),
        schema: pulumiModuleSchema(),
        handlers: {
          async suggestModules({ name, path }) {
            const files = await readdir(path)

            if (files.filter((f) => f.toLowerCase() === "pulumi.yaml" || f.toLowerCase() === "pulumi.yml").length > 0) {
              return {
                suggestions: [
                  {
                    description: `based on found Pulumi.yaml file`,
                    module: {
                      type: "pulumi",
                      name,
                      autoApply: false,
                    },
                  },
                ],
              }
            } else {
              return { suggestions: [] }
            }
          },
          configure: configurePulumiModule,
          getServiceStatus: getPulumiStatus,
          deployService: deployPulumi,
          deleteService: deletePulumiModule,
        },
      },
    ],
    tools: [
      {
        name: "pulumi",
        description: "The pulumi CLI",
        type: "binary",
        builds: [
          {
            platform: "darwin",
            architecture: "amd64",
            url: "https://github.com/pulumi/pulumi/releases/download/v3.9.1/pulumi-v3.9.1-darwin-x64.tar.gz",
            sha256: "d6f674e58c5cc0dd2f71bb4a29b06bce3cabe004c05f5e3b238926626d0d4f95",
            extract: {
              format: "tar",
              targetPath: "pulumi/pulumi",
            },
          },
          {
            platform: "linux",
            architecture: "amd64",
            url: "https://github.com/pulumi/pulumi/releases/download/v3.9.1/pulumi-v3.9.1-linux-x64.tar.gz",
            sha256: "dc1a47ee67ee271070bdf807cc8a27bba055eaeba80689f8704637bb07e59d1b",
            extract: {
              format: "tar",
              targetPath: "pulumi/pulumi",
            },
          },
          {
            platform: "windows",
            architecture: "amd64",
            url: "https://github.com/pulumi/pulumi/releases/download/v3.9.1/pulumi-v3.9.1-windows-x64.zip",
            sha256: "65f007fae639844cedccfe6197f600946c16d80ab184091f7c555fe07168d00d",
            extract: {
              format: "zip",
              targetPath: "pulumi/bin/pulumi.exe",
            },
          },
        ],
      }
    ],
  })
