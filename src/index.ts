import { Command, flags } from '@oclif/command';
import * as Parser from '@oclif/parser';
import { existsSync, promises as fspromises } from 'fs';
import { createInterface } from 'readline';
import { parse, resolve } from 'path';
import { CONFIG } from './config';
import { doesFileHaveExifDate } from './helpers/does-file-have-exif-date';
import { findSupportedMediaFiles } from './helpers/find-supported-media-files';
import { readPhotoTakenTimeFromGoogleJson } from './helpers/read-photo-taken-time-from-google-json';
import { updateExifMetadata } from './helpers/update-exif-metadata';
import { updateFileModificationDate } from './helpers/update-file-modification-date';
import { Directories } from './models/directories'

const { readdir, mkdir, copyFile, writeFile, appendFile } = fspromises;

function promptConfirm(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
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
  }

  static args: Parser.args.Input = []

  async run() {
    const { args, flags } = this.parse(GooglePhotosExif);
    const { inputDir, outputDir, errorDir, inPlace, dryRun, yes } = flags;

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
    await this.processMediaFiles(directories);

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

  private async processMediaFiles(directories: Directories): Promise<void> {
    this.log(`--- Processing media files ---`);
    const fileNamesWithEditedExif: string[] = [];
    let processedFileCount = 0;
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

    const mediaFileGenerator = findSupportedMediaFiles(directories.input, directories.output);

    for await (const mediaFile of mediaFileGenerator) {
      processedFileCount++;

      const ext = mediaFile.mediaFileExtension.toLowerCase();
      mediaFileCountsByExtension.set(ext, (mediaFileCountsByExtension.get(ext) || 0) + 1);

      // Copy the file into output directory
      if (directories.inPlace) {
        this.log(`[${processedFileCount}] Modifying file in-place: ${mediaFile.mediaFilePath}`);
      } else {
        this.log(`[${processedFileCount}] Copying file: ${mediaFile.mediaFilePath} -> ${mediaFile.outputFileName}`);
        if (!directories.dryRun) {
          await copyFile(mediaFile.mediaFilePath, mediaFile.outputFilePath);
        }
      }

      // Process the output file, setting the modified timestamp and/or EXIF metadata where necessary
      const photoTimeTaken = await readPhotoTakenTimeFromGoogleJson(mediaFile);

      if (photoTimeTaken) {
        let needsExifUpdate = false;
        let needsModTimeUpdate = true; // Always true if photoTimeTaken is present

        if (mediaFile.supportsExif) {
          const hasExifDate = await doesFileHaveExifDate(mediaFile.mediaFilePath);
          if (!hasExifDate) {
            needsExifUpdate = true;
            fileNamesWithEditedExif.push(mediaFile.outputFileName);
            if (!directories.dryRun) {
              await updateExifMetadata(mediaFile, photoTimeTaken, directories.error);
              this.log(`Wrote "DateTimeOriginal" EXIF metadata to: ${mediaFile.outputFileName}`);
            } else {
              this.log(`[DRY RUN] Would write "DateTimeOriginal" EXIF metadata to: ${mediaFile.outputFileName}`);
            }
          }
        }

        if (!directories.dryRun) {
          await updateFileModificationDate(mediaFile.outputFilePath, photoTimeTaken);
        }

        if (directories.dryRun) {
          const row = `| \`${mediaFile.mediaFilePath}\` | \`${directories.inPlace ? 'IN-PLACE' : mediaFile.outputFilePath}\` | ${needsExifUpdate ? '✅ Yes' : '❌ No'} | ${needsModTimeUpdate ? '✅ Yes' : '❌ No'} |\n`;
          await appendFile(reportPath!, row);
        }
      } else {
        if (directories.dryRun) {
          const row = `| \`${mediaFile.mediaFilePath}\` | \`${directories.inPlace ? 'IN-PLACE' : mediaFile.outputFilePath}\` | ❌ No (No JSON) | ❌ No (No JSON) |\n`;
          await appendFile(reportPath!, row);
        }
      }
    }

    this.log(`--- Finished processing media files: ---`);
    mediaFileCountsByExtension.forEach((count, extension) => {
      this.log(`${count} files with extension ${extension}`);
    });
    this.log(`--- The file modified timestamp has been updated on all media files ---`)
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
