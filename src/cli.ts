import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import {
  promptChoice,
  promptYesNo,
  promptText,
  promptCacheOrFresh,
  buildProcessArgs,
  closePrompt,
} from './shared/cliHelpers';
import { getAvailableProfiles } from './shared/profileLoader';

let DATA_DIR = path.join(process.cwd(), 'data');
let selectedProfile: string = '';

/**
 * Print the equivalent npm run command for direct CLI use
 */
function printEquivalentCommand(npmScript: string, args: string[]): void {
  const escaped = args.map((a) => (a.includes(' ') ? `"${a}"` : a));
  const suffix = escaped.length > 0 ? ` -- ${escaped.join(' ')}` : '';
  console.log(`\n💡 Next time you can run directly:\n   npm run ${npmScript}${suffix}\n`);
}

/**
 * Run an external entry point with the given arguments
 */
async function runEntryPoint(
  entryPoint: string,
  args: string[],
  executor: 'tsx' = 'tsx'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executor, [entryPoint, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Activity Export workflow
 */
async function activityExportFlow(): Promise<void> {
  console.log('\n📊 Activity Export\n');

  // Check for cached activities
  const cachedPath = path.join(DATA_DIR, 'activities.json');
  let isTransformOnly = false;
  let transformFilePath = '';

  const mode = await promptChoice(
    'What would you like to do?',
    [
      { label: 'Fetch fresh activities from Garmin', value: 'fetch' },
      { label: 'Transform saved raw data (faster)', value: 'transform' },
    ],
    0
  );

  const answers: Record<string, any> = {
    mock: await promptYesNo('Use mock data?', false),
  };

  if (mode === 'transform') {
    isTransformOnly = true;
    answers.isTransformOnly = true;
    transformFilePath = await promptText(
      'Path to raw activities file',
      path.join(DATA_DIR, 'activities-raw.json')
    );
    answers.transformFilePath = transformFilePath;

    // Optional: date range for transform-only
    const addDateRange = await promptYesNo('Filter by date range?', false);
    if (addDateRange) {
      const weekStart = await promptText('Week start (YYYY-MM-DD)', '');
      const weekEnd = await promptText('Week end (YYYY-MM-DD)', '');
      if (weekStart) answers.weekStart = weekStart;
      if (weekEnd) answers.weekEnd = weekEnd;
    }
  } else {
    // Fetch mode
    isTransformOnly = false;
    const limit = await promptText('How many activities to fetch?', '20');
    answers.limit = limit;

    const period = await promptChoice(
      'Time period?',
      [
        { label: 'Last 20 activities', value: 'all' },
        { label: 'Last week', value: 'last-week' },
        { label: 'This week', value: 'this-week' },
        { label: 'Last 4 weeks', value: 'last-4-weeks' },
      ],
      0
    );
    answers.timePeriod = period;

    const includeDetail = await promptYesNo('Include detailed data (slower)?', true);
    if (!includeDetail) answers.noDetailed = true;

    // Optional: save raw response
    const saveRaw = await promptYesNo('Save raw Garmin response?', false);
    if (saveRaw) answers.raw = true;
  }

  // Output path
  const outputPath = await promptText('Output file path', path.join(DATA_DIR, 'activities.json'));
  answers.outputPath = outputPath;

  // Build and run
  answers.profile = selectedProfile;
  const args = buildProcessArgs('export-activities', answers);
  closePrompt();

  printEquivalentCommand('export-activities', args);
  console.log('\n🚀 Running activity export...\n');
  await runEntryPoint('src/exportActivities.ts', args);
}

/**
 * Workout Management workflow
 */
async function workoutManagementFlow(): Promise<void> {
  console.log('\n💪 Workout Management\n');

  const operation = await promptChoice(
    'Which operation?',
    [
      { label: 'Export all workouts', value: 'export' },
      { label: 'Generate next-week template', value: 'template' },
      { label: 'Schedule workouts from file', value: 'schedule' },
      { label: 'Upload workouts to Garmin', value: 'upload' },
      { label: 'Copy plan shifted 7 days', value: 'copy-next-week' },
      { label: 'Start new training plan (reset schedule)', value: 'start-new-plan' },
    ],
    0
  );

  const answers: Record<string, any> = {
    operation,
    mock: await promptYesNo('Use mock data?', false),
  };

  // For operations that need a file
  if (operation === 'schedule' || operation === 'upload' || operation === 'copy-next-week') {
    const workoutFile = await promptText('Workout file path', path.join(DATA_DIR, 'workouts.json'));
    answers.workoutFile = workoutFile;
  }

  if (operation === 'start-new-plan') {
    const workoutPlanFile = await promptText('Workout plan file path', path.join(DATA_DIR, 'next-week.workouts.tmp.json'));
    const trainingPlanFile = await promptText('Training plan file path', path.join(DATA_DIR, 'training-plan.json'));
    answers.workoutFile = workoutPlanFile;
    answers.planFile = trainingPlanFile;
  }

  // Dry run option for operations that modify data
  if (operation === 'schedule' || operation === 'upload' || operation === 'copy-next-week') {
    const dryRun = await promptYesNo('Dry run (preview without changes)?', false);
    if (dryRun) answers.dryRun = true;
  }

  // Output path (optional for most, required for template)
  if (operation === 'template' || operation === 'export' || operation === 'copy-next-week') {
    const outputPath = await promptText(
      'Output file path',
      operation === 'template' ? path.join(DATA_DIR, 'next-week.workouts.json') : path.join(DATA_DIR, 'workouts.json')
    );
    answers.outputPath = outputPath;
  }

  // Build and run
  answers.profile = selectedProfile;
  const args = buildProcessArgs('manage-workouts', answers);
  closePrompt();

  printEquivalentCommand('manage-workouts', args);
  console.log('\n🚀 Running workout management...\n');
  await runEntryPoint('src/manageWorkouts.ts', args);
}

/**
 * Adjust Workouts workflow
 */
async function adjustWorkoutsFlow(): Promise<void> {
  console.log('\n🤖 Adjust Workouts\n');

  const flow = await promptChoice(
    'Which AI workflow?',
    [
      { label: 'Adjust next-week workouts', value: 'adjust-workouts' },
      { label: 'Revisit training plan', value: 'revisit-plan' },
    ],
    0
  );

  const answers: Record<string, any> = {
    mode: flow,
    mock: await promptYesNo('Use mock data?', false),
  };

  if (flow === 'revisit-plan') {
    const planFile = await promptText('Training plan file path', path.join(DATA_DIR, 'training-plan.json'));
    const includeActivities = await promptYesNo('Include activities context file?', false);
    const includeWorkouts = await promptYesNo('Include workouts context file?', false);
    const notes = await promptText('Additional review notes (optional)', '');
    const outputPath = await promptText('Output training plan path', planFile);

    answers.planFile = planFile;
    if (includeActivities) {
      answers.activitiesFile = await promptText('Activities file path', path.join(DATA_DIR, 'activities.json'));
    }
    if (includeWorkouts) {
      answers.workoutsFile = await promptText('Workouts file path', path.join(DATA_DIR, 'next-week.workouts.tmp.json'));
    }
    if (notes) answers.reviewNotes = notes;
    answers.outputPath = outputPath;

    answers.profile = selectedProfile;
    const args = buildProcessArgs('adjust-workouts', answers);
    closePrompt();

    printEquivalentCommand('adjust-workouts', args);
    console.log('\n🚀 Running training-plan revisit...\n');
    await runEntryPoint('src/adjustWorkouts.ts', args, 'tsx');
    return;
  }

  const week = await promptChoice(
    'Which week to analyze?',
    [
      { label: 'Last week', value: 'last-week' },
      { label: 'This week', value: 'this-week' },
    ],
    1 // Default to this-week
  );

  // Check for cached files
  const activitiesCached = path.join(DATA_DIR, 'activities.json');
  const workoutsCached = path.join(DATA_DIR, 'workouts.json');
  const weeklyWorkoutsCached = path.join(DATA_DIR, 'next-week.workouts.tmp.json');
  const planCached = path.join(DATA_DIR, 'training-plan.json');
  const defaultWorkoutsFile = fs.existsSync(weeklyWorkoutsCached)
    ? weeklyWorkoutsCached
    : workoutsCached;

  const useCache = await promptYesNo('Use cached files or fetch fresh?', true);

  answers.week = week;

  if (useCache) {
    console.log(`💡 Tip: prefer a weekly workout plan file (for example ${path.join(DATA_DIR, 'next-week.workouts.tmp.json')}).`);
    const activitiesFile = await promptText('Activities file path', activitiesCached);
    const workoutsFile = await promptText('Workouts file path (weekly plan recommended)', defaultWorkoutsFile);
    const planFile = await promptText('Training plan file path', planCached);

    answers.activitiesFile = activitiesFile;
    answers.workoutsFile = workoutsFile;
    answers.planFile = planFile;
  } else {
    answers.cached = 'fresh';
  }

  // Dry run
  const dryRun = await promptYesNo('Dry run (validate only)?', false);
  if (dryRun) answers.dryRun = true;

  // Output path
  const outputPath = await promptText('Output file path', path.join(DATA_DIR, 'workouts-adjusted.json'));
  answers.outputPath = outputPath;

  // Build and run
  answers.profile = selectedProfile;
  const args = buildProcessArgs('adjust-workouts', answers);
  closePrompt();

  // For fresh-fetch runs, the hint should use the default cache paths (where fresh data gets saved)
  // so the next run works without needing Garmin credentials.
  let hintArgs = args;
  if (answers.cached === 'fresh') {
    const hintAnswers = {
      ...answers,
      cached: undefined,
      activitiesFile: activitiesCached,
      workoutsFile: weeklyWorkoutsCached,
      planFile: planCached,
    };
    hintArgs = buildProcessArgs('adjust-workouts', hintAnswers);
  }
  printEquivalentCommand('adjust-workouts', hintArgs);
  console.log('\n🚀 Running workout adjustment...\n');
  await runEntryPoint('src/adjustWorkouts.ts', args, 'tsx');
}

/**
 * Profile selection — must happen before any workflow
 */
async function selectProfile(): Promise<string> {
  const profiles = getAvailableProfiles();

  if (profiles.length === 0) {
    console.error('\n❌ No profiles found.');
    console.error('   Create .env.<name> files (e.g., .env.MED, .env.Julie) in the project root.');
    console.error('   Each file should contain GARMIN_EMAIL and GARMIN_PASSWORD.');
    process.exit(1);
  }

  if (profiles.length === 1) {
    console.log(`\n👤 Using profile: ${profiles[0]}`);
    return profiles[0];
  }

  const choice = await promptChoice(
    'Select profile:',
    profiles.map((p) => ({ label: p, value: p })),
    0
  );

  return choice;
}

/**
 * Main menu
 */
async function mainMenu(): Promise<void> {
  console.log('\n🏃 Garmin Workout Editor\n');

  // Profile selection first
  selectedProfile = await selectProfile();
  DATA_DIR = path.join(process.cwd(), 'data', selectedProfile);

  // Ensure profile data dir exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log(`\n📂 Data directory: ${DATA_DIR}\n`);
  console.log('Select an operation:\n');

  const operation = await promptChoice(
    'What would you like to do?',
    [
      { label: 'Activity Export', value: 'activities' },
      { label: 'Workout Management', value: 'workouts' },
      { label: 'Adjust Workouts (AI-powered)', value: 'adjust' },
    ],
    0
  );

  console.clear();

  try {
    switch (operation) {
      case 'activities':
        await activityExportFlow();
        break;
      case 'workouts':
        await workoutManagementFlow();
        break;
      case 'adjust':
        await adjustWorkoutsFlow();
        break;
    }
    console.log('\n✅ Operation completed successfully!\n');
  } catch (err) {
    closePrompt();
    console.error('\n❌ Operation failed:', err);
    process.exit(1);
  }
}

// Run main menu
mainMenu().catch((err) => {
  closePrompt();
  console.error('Fatal error:', err);
  process.exit(1);
});
