import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * Prompt user with a yes/no question
 * @param message Question to ask
 * @param defaultAnswer Default value (true for yes, false for no)
 */
export async function promptYesNo(
  message: string,
  defaultAnswer: boolean = true
): Promise<boolean> {
  const defaultStr = defaultAnswer ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`${message} (${defaultStr}): `, (answer) => {
      if (answer.trim() === '') {
        resolve(defaultAnswer);
      } else {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      }
    });
  });
}

/**
 * Prompt user with a text input question
 * @param message Question to ask
 * @param defaultValue Default value to use if user just presses Enter
 */
export async function promptText(
  message: string,
  defaultValue?: string
): Promise<string> {
  return new Promise((resolve) => {
    const displayMsg =
      defaultValue !== undefined ? `${message} [${defaultValue}]: ` : `${message}: `;
    rl.question(displayMsg, (answer) => {
      resolve(answer.trim() === '' && defaultValue ? defaultValue : answer.trim());
    });
  });
}

/**
 * Prompt user to choose from a list of options
 * @param message Question to ask
 * @param options Array of{ label, value } objects
 * @param defaultIndex Default option index (0-based)
 */
export async function promptChoice(
  message: string,
  options: Array<{ label: string; value: string }>,
  defaultIndex: number = 0
): Promise<string> {
  console.log(`\n${message}`);
  options.forEach((opt, idx) => {
    const marker = idx === defaultIndex ? '→' : ' ';
    console.log(`  ${marker} ${idx + 1}. ${opt.label}`);
  });

  return new Promise((resolve) => {
    const defaultDisplay = defaultIndex + 1;
    rl.question(`\nEnter choice (1-${options.length}) [${defaultDisplay}]: `, (answer) => {
      const input = answer.trim();
      if (input === '') {
        resolve(options[defaultIndex].value);
      } else {
        const idx = parseInt(input, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          resolve(options[idx].value);
        } else {
          console.log(`Invalid choice. Using default.`);
          resolve(options[defaultIndex].value);
        }
      }
    });
  });
}

/**
 * Prompt user to choose between using cached data or fetching fresh
 * @param dataType Type of data (e.g., "activities", "workouts")
 * @param cachedPath Path to cached file
 * @returns 'cached' or 'fresh'
 */
export async function promptCacheOrFresh(
  dataType: string,
  cachedPath: string
): Promise<'cached' | 'fresh'> {
  const fileExists = fs.existsSync(cachedPath);

  if (!fileExists) {
    console.log(`\n⚠️  No cached ${dataType} file found at ${cachedPath}`);
    console.log('Fetching fresh data from Garmin API...\n');
    return 'fresh';
  }

  const stat = fs.statSync(cachedPath);
  const mtime = stat.mtime.toLocaleString();
  console.log(`\n📁 Cached ${dataType} found at ${cachedPath}`);
  console.log(`   Last updated: ${mtime}`);

  const choice = await promptChoice(
    `Use cached data or fetch fresh from Garmin?`,
    [
      { label: 'Use cached file', value: 'cached' },
      { label: 'Fetch fresh from API', value: 'fresh' },
    ],
    0 // Default to cached
  );

  return choice as 'cached' | 'fresh';
}

/**
 * Close the readline interface
 */
export function closePrompt(): void {
  rl.close();
}

/**
 * Extract a flag value from process.argv
 * @param flag Flag name (e.g., '--output', '--type')
 * @returns Value or undefined if not found
 */
export function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

/**
 * Check if a flag exists in process.argv
 * @param flag Flag name (e.g., '--mock', '--raw')
 */
export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/**
 * Get positional arguments (everything that's not a flag or flag value)
 */
export function getPositionalArgs(): string[] {
  const args: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      // Skip flag and its value
      if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
        i++;
      }
    } else {
      args.push(arg);
    }
  }
  return args;
}

/**
 * Build process.argv-compatible array from user answers
 * @param operation Operation type ('export-activities' | 'manage-workouts' | 'adjust-workouts')
 * @param answers Object with user-selected options
 */
export function buildProcessArgs(
  operation: 'export-activities' | 'manage-workouts' | 'adjust-workouts',
  answers: Record<string, any>
): string[] {
  const args: string[] = [];

  // Handle operation-specific arguments based on the operation type
  if (operation === 'export-activities') {
    if (answers.isTransformOnly) {
      args.push('--transform-only', answers.transformFilePath);
      if (answers.weekStart) args.push('--week-start', answers.weekStart);
      if (answers.weekEnd) args.push('--week-end', answers.weekEnd);
    } else {
      if (answers.limit) args.push(answers.limit);
      if (answers.timePeriod && answers.timePeriod !== 'all') {
        args.push(`--${answers.timePeriod}`);
      }
      if (answers.activityType) args.push('--type', answers.activityType);
      if (answers.noDetailed) args.push('--no-detailed');
    }
    if (answers.outputPath) args.push('--output', answers.outputPath);
    if (answers.raw) args.push('--raw');
  } else if (operation === 'manage-workouts') {
    if (answers.operation) {
      if (answers.operation === 'export') {
        args.push('--export');
      } else if (answers.operation === 'template') {
        args.push('--generate-template');
      } else if (answers.operation === 'schedule') {
        args.push('--schedule', answers.workoutFile);
      } else if (answers.operation === 'upload') {
        args.push('--upload', answers.workoutFile);
      } else if (answers.operation === 'copy-next-week') {
        args.push('--copy-next-week', answers.workoutFile);
      }
    }
    if (answers.outputPath) args.push('--output', answers.outputPath);
    if (answers.dryRun) args.push('--dry-run');
  } else if (operation === 'adjust-workouts') {
    if (answers.week) args.push(`--${answers.week}`);
    if (answers.useCache === false || answers.cached === 'fresh') {
      // Fetch mode, no additional args needed for file paths
    } else {
      if (answers.activitiesFile) args.push('--activities', answers.activitiesFile);
      if (answers.workoutsFile) args.push('--workouts', answers.workoutsFile);
      if (answers.planFile) args.push('--plan', answers.planFile);
    }
    if (answers.outputPath) args.push('--output', answers.outputPath);
    if (answers.dryRun) args.push('--dry-run');
  }

  // Common flags
  if (answers.mock) args.push('--mock');

  return args;
}
