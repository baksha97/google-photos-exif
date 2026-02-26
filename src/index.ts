import { Command, flags } from '@oclif/command';
import * as Parser from '@oclif/parser';
import { existsSync, promises as fspromises } from 'fs';
import { createInterface } from 'readline';
import { parse, resolve } from 'path';
import * as os from 'os';
import { SingleBar, Presets } from 'cli-progress';
import { ExifTool } from 'exiftool-vendored';
import { CONFIG } from './config';
import { doesFileHaveExifDate } from './helpers/does-file-have-exif-date';
import { findSupportedMediaFiles } from './helpers/find-supported-media-files';
import { findFilesWithExtensionRecursively } from './helpers/find-files-with-extension-recursively';
import { readPhotoTakenTimeFromGoogleJson } from './helpers/read-photo-taken-time-from-google-json';
import { updateExifMetadata } from './helpers/update-exif-metadata';
import { updateFileModificationDate } from './helpers/update-file-modification-date';
import { Directories } from './models/directories';
import { MediaFileInfo } from './models/media-file-info';

const { readdir, mkdir, copyFile, writeFile, appendFile } = fspromises;

class Semaphore {
  private queue: (() => void)[] = [];
  private count: number;
  constructor(n: number) { this.count = n; }
  acquire(): Promise<void> {
    if (this.count > 0) { this.count--; return Promise.resolve(); }
    return new Promise(r => this.queue.push(r));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.count++;
  }
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function countMediaFiles(inputDir: string): Promise<number> {
  const exts = CONFIG.supportedMediaFileTypes.map(t => t.extension);
  let count = 0;
  for await (const _ of findFilesWithExtensionRecursively(inputDir, exts)) count++;
  return count;
}

class GooglePhotosExif extends Command {
  static description = `Takes in a directory path for an extracted Google Photos Takeout. Extracts all photo/video files (based on the conigured list of file extensions) and optionally places them into an output directory or updates them in-place. All files will have their modified timestamp set to match the timestamp specified in Google's JSON metadata files (where present). In addition, for file types that support EXIF, the EXIF "DateTimeOriginal" field will be set to the timestamp from Google's JSON metadata, if the field is not already set in the EXIF metadata.`;

  static flags = {
    version: flags.version({ char: 'v' }),
    help: flags.help({ char: 'h' }),
    inputDir: flags.string({
      char: 'i',
      description: 'Directory containing the extracted contents of Google Photos Takeout zip file',
      required: true,
    }),
    inPlace: flags.boolean({
      description: 'Whether to modify the files in-place instead of copying them to an output directory',
      default: false,
    }),
    yes: flags.boolean({
      char: 'y',
      description: 'Skip the confirmation prompt when using --inPlace',
      default: false,
    }),
    dryRun: flags.boolean({
      description: 'Whether to run in dry-run mode, which will not modify any files but will generate a report of the planned changes',
      default: false,
    }),
    outputDir: flags.string({
      char: 'o',
      description: 'Directory into which the processed output will be written',
      required: false,
    }),
    errorDir: flags.string({
      char: 'e',
      description: 'Directory for any files that have bad EXIF data - including the matching metadata files',
      required: true,
    }),
    concurrency: flags.integer({
      char: 'c',
      description: 'Number of files to process concurrently',
      default: Math.min(os.cpus().length, 8),
    }),
    verbose: flags.boolean({
      description: 'Show per-file log output (default: only progress bar + summary)',
      default: false,
    }),
  }

  static args: Parser.args.Input = []

  async run() {
    const { args, flags } = this.parse(GooglePhotosExif);
    const { inputDir, outputDir, errorDir, inPlace, dryRun, yes, verbose } = flags;
    let { concurrency } = flags;

    if (dryRun) {
      concurrency = 1;
    }

    if (inPlace && !dryRun && !yes) {
      this.warn(`--inPlace will modify files directly inside ${inputDir}. This cannot be undone.`);
      const confirmed = await promptConfirm('Are you sure you want to proceed? [y/N] ');
      if (!confirmed) {
        this.log('Aborted.');
        this.exit(0);
      }
    }

    const directories = this.determineDirectoryPaths(inputDir, outputDir, errorDir, inPlace, dryRun);
    await this.prepareDirectories(directories);

    this.log('--- Scanning for media files ---');
    const totalFileCount = await countMediaFiles(inputDir);
    this.log(`--- Found ${totalFileCount} media files. Processing with concurrency=${concurrency} ---`);

    const exiftoolInstance = new ExifTool({ maxProcs: concurrency });
    try {
      await this.processMediaFiles(directories, exiftoolInstance, concurrency, verbose, totalFileCount);
    } finally {
      await exiftoolInstance.end();
    }

    this.log('Done 🎉');
    this.exit(0);
  }

  private determineDirectoryPaths(inputDir: string, outputDir: string | undefined, errorDir: string, inPlace: boolean, dryRun: boolean): Directories {
    return {
      input: inputDir,
      output: outputDir,
      inPlace: inPlace,
      dryRun: dryRun,
      error: errorDir,
    };
  }

  private async prepareDirectories(directories: Directories): Promise<void> {
    if (!directories.input || !existsSync(directories.input)) {
      throw new Error('The input directory must exist');
    }

    if (directories.inPlace && directories.output) {
      throw new Error('You cannot specify an output directory when --inPlace is used');
    }

    if (!directories.inPlace && !directories.output) {
      throw new Error('You must specify an output directory using the --outputDir flag unless you use --inPlace');
    }

    if (!directories.error) {
      throw new Error('You must specify an error directory using the --errorDir flag');
    }

    if (!directories.dryRun) {
      if (directories.output) {
        await this.checkDirIsEmptyAndCreateDirIfNotFound(directories.output, 'If the output directory already exists, it must be empty');
      }
      await this.checkDirIsEmptyAndCreateDirIfNotFound(directories.error, 'If the error directory already exists, it must be empty');
    }
  }

  private async checkDirIsEmptyAndCreateDirIfNotFound(directoryPath: string, messageIfNotEmpty: string): Promise<void> {
    const folderExists = existsSync(directoryPath);
    if (folderExists) {
      const folderContents = await readdir(directoryPath);
      const folderContentsExcludingDSStore = folderContents.filter(filename => filename !== '.DS_Store');
      const folderIsEmpty = folderContentsExcludingDSStore.length === 0;
      if (!folderIsEmpty) {
        throw new Error(messageIfNotEmpty);
      }
    } else {
      this.log(`--- Creating directory: ${directoryPath} ---`);
      await mkdir(directoryPath);
    }
  }

  private async processOneFile(
    mediaFile: MediaFileInfo,
    directories: Directories,
    exiftoolInstance: ExifTool,
    verbose: boolean,
    bar: SingleBar,
    fileNamesWithEditedExif: string[],
    mediaFileCountsByExtension: Map<string, number>,
    reportPath: string | undefined,
    fileIndex: { value: number },
  ): Promise<void> {
    const idx = ++fileIndex.value;
    const ext = mediaFile.mediaFileExtension.toLowerCase();
    mediaFileCountsByExtension.set(ext, (mediaFileCountsByExtension.get(ext) || 0) + 1);

    if (directories.inPlace) {
      if (verbose) this.log(`[${idx}] Modifying file in-place: ${mediaFile.mediaFilePath}`);
    } else {
      if (verbose) this.log(`[${idx}] Copying file: ${mediaFile.mediaFilePath} -> ${mediaFile.outputFileName}`);
      if (!directories.dryRun) {
        await copyFile(mediaFile.mediaFilePath, mediaFile.outputFilePath);
      }
    }

    const photoTimeTaken = await readPhotoTakenTimeFromGoogleJson(mediaFile);

    if (photoTimeTaken) {
      let needsExifUpdate = false;
      const needsModTimeUpdate = true;

      if (mediaFile.supportsExif) {
        const hasExifDate = await doesFileHaveExifDate(mediaFile.mediaFilePath, exiftoolInstance);
        if (!hasExifDate) {
          needsExifUpdate = true;
          fileNamesWithEditedExif.push(mediaFile.outputFileName);
          if (!directories.dryRun) {
            await updateExifMetadata(mediaFile, photoTimeTaken, directories.error, exiftoolInstance);
            if (verbose) this.log(`Wrote "DateTimeOriginal" EXIF metadata to: ${mediaFile.outputFileName}`);
          } else {
            if (verbose) this.log(`[DRY RUN] Would write "DateTimeOriginal" EXIF metadata to: ${mediaFile.outputFileName}`);
          }
        }
      }

      if (!directories.dryRun) {
        await updateFileModificationDate(mediaFile.outputFilePath, photoTimeTaken);
      }

      if (directories.dryRun && reportPath) {
        const row = `| \`${mediaFile.mediaFilePath}\` | \`${directories.inPlace ? 'IN-PLACE' : mediaFile.outputFilePath}\` | ${needsExifUpdate ? '✅ Yes' : '❌ No'} | ${needsModTimeUpdate ? '✅ Yes' : '❌ No'} |\n`;
        await appendFile(reportPath, row);
      }
    } else {
      if (directories.dryRun && reportPath) {
        const row = `| \`${mediaFile.mediaFilePath}\` | \`${directories.inPlace ? 'IN-PLACE' : mediaFile.outputFilePath}\` | ❌ No (No JSON) | ❌ No (No JSON) |\n`;
        await appendFile(reportPath, row);
      }
    }

    bar.increment();
  }

  private async processMediaFiles(
    directories: Directories,
    exiftoolInstance: ExifTool,
    concurrency: number,
    verbose: boolean,
    totalFileCount: number,
  ): Promise<void> {
    const fileNamesWithEditedExif: string[] = [];
    const fileIndex = { value: 0 };
    let reportPath: string | undefined;

    if (directories.dryRun) {
      reportPath = resolve(directories.input, 'dry-run-report.md');
      const header = `# Dry Run Report\n\nRun with \`--dryRun\` flag. The following actions would be taken:\n\n| Source File | Target / In-Place Path | Needs EXIF Update | Needs ModTime Update |\n|-------------|-------------------------|-------------------|----------------------|\n`;
      await writeFile(reportPath, header);
      this.log(`\n--- Dry Run Report started at ${reportPath} ---`);
    }

    const supportedMediaFileExtensions = CONFIG.supportedMediaFileTypes.map(fileType => fileType.extension);
    const mediaFileCountsByExtension = new Map<string, number>();
    supportedMediaFileExtensions.forEach(ext => mediaFileCountsByExtension.set(ext, 0));

    const bar = new SingleBar({
      format: 'Progress |{bar}| {value}/{total} ({percentage}%) | ETA: {eta_formatted} | {speed} files/s',
      etaBuffer: 50,
      clearOnComplete: false,
      hideCursor: true,
    }, Presets.shades_classic);

    bar.start(totalFileCount, 0, { speed: 'N/A' });

    const sem = new Semaphore(concurrency);
    const inFlight: Promise<void>[] = [];

    const mediaFileGenerator = findSupportedMediaFiles(directories.input, directories.output);

    for await (const mediaFile of mediaFileGenerator) {
      await sem.acquire();
      inFlight.push(
        this.processOneFile(
          mediaFile,
          directories,
          exiftoolInstance,
          verbose,
          bar,
          fileNamesWithEditedExif,
          mediaFileCountsByExtension,
          reportPath,
          fileIndex,
        ).finally(() => sem.release())
      );
    }

    await Promise.all(inFlight);
    bar.stop();

    this.log(`--- Finished processing media files: ---`);
    mediaFileCountsByExtension.forEach((count, extension) => {
      this.log(`${count} files with extension ${extension}`);
    });
    this.log(`--- The file modified timestamp has been updated on all media files ---`);
    if (fileNamesWithEditedExif.length > 0) {
      this.log(`--- Found ${fileNamesWithEditedExif.length} files which support EXIF, but had no DateTimeOriginal field. For each of the following files, the DateTimeOriginalField has been updated using the date found in the JSON metadata: ---`);
      fileNamesWithEditedExif.forEach(fileNameWithEditedExif => this.log(fileNameWithEditedExif));
    } else {
      this.log(`--- We did not edit EXIF metadata for any of the files. This could be because all files already had a value set for the DateTimeOriginal field, or because we did not have a corresponding JSON file. ---`);
    }

    if (directories.dryRun) {
      this.log(`\n--- Dry Run Report completed and saved at ${reportPath!} ---`);
    }
  }
}

export = GooglePhotosExif
