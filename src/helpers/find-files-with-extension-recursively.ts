import { promises as fspromises } from 'fs';
import { join, extname } from 'path';

const { readdir } = fspromises;

const IGNORABLE_ERROR_CODES = new Set(['EACCES', 'ENOENT', 'EPERM']);

export async function* findFilesWithExtensionRecursively(dirToSearch: string, extensionsToInclude: string[]): AsyncGenerator<string> {
  const extensionSet = new Set(extensionsToInclude.map(ext => ext.toLowerCase()));

  let entries;
  try {
    entries = await readdir(dirToSearch, { withFileTypes: true });
  } catch (err: any) {
    if (IGNORABLE_ERROR_CODES.has(err.code)) return;
    throw err;
  }

  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name.startsWith('._')) continue;
    const fullPath = join(dirToSearch, entry.name);

    if (entry.isDirectory()) {
      yield* findFilesWithExtensionRecursively(fullPath, extensionsToInclude);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (extensionSet.has(ext)) {
        yield fullPath;
      }
    }
  }
}
