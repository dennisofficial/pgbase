import { generatorHandler, type GeneratorOptions } from '@prisma/generator-helper';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_FORMAT_VERSION } from '../version.js';
import { dmmfToStaticSchema, GeneratorValidationError } from './dmmf-to-static.js';
import { emitStaticSchemaModule } from './emit.js';

const DEFAULT_OUTPUT = '../src/generated/pgbase';
const DEFAULT_PACKAGE_SPECIFIER = '@workspace/pgbase/schema';
const OUTPUT_FILE_NAME = 'index.ts';

export function runGenerator(): void {
  generatorHandler({
    onManifest() {
      return {
        prettyName: 'pgbase schema',
        defaultOutput: DEFAULT_OUTPUT,
        version: `schema format v${SCHEMA_FORMAT_VERSION}`,
        requiresGenerators: [],
      };
    },
    async onGenerate(options: GeneratorOptions) {
      await onGenerate(options);
    },
  });
}

async function onGenerate(options: GeneratorOptions): Promise<void> {
  const activeProvider = options.datasources[0]?.activeProvider;
  if (!activeProvider) {
    throw new GeneratorValidationError(
      'pgbase: no datasource found in schema.prisma. pgbase needs exactly one ' +
        '"postgresql" datasource to validate against.',
    );
  }

  const staticSchema = dmmfToStaticSchema(options.dmmf.datamodel, {
    activeProvider,
    formatVersion: SCHEMA_FORMAT_VERSION,
  });

  if (staticSchema.models.length === 0) {
    throw new GeneratorValidationError(
      'pgbase: the datamodel has no models. Nothing to generate — check the ' +
        '"schema" path in the pgbase generator block and in prisma.config.ts.',
    );
  }

  const packageSpecifier =
    (options.generator.config.packageSpecifier as string | undefined) ?? DEFAULT_PACKAGE_SPECIFIER;

  const source = emitStaticSchemaModule(staticSchema, { packageSpecifier });

  const outputDir = options.generator.output?.value;
  if (!outputDir) {
    throw new GeneratorValidationError(
      'pgbase: no "output" resolved for the generator block. This should never ' +
        `happen — the manifest declares a defaultOutput (${DEFAULT_OUTPUT}).`,
    );
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, OUTPUT_FILE_NAME), source, 'utf-8');
}
