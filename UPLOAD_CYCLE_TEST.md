# Workout Upload Cycle Integration Test Documentation

## Overview

The **Workout Upload Cycle Integration Test** (`workoutEditor.upload-cycle.test.ts`) is designed to verify data integrity through the complete workflow of transforming, uploading, and re-downloading workout data from Garmin.

## Problem It Solves

There have been recurring issues with workout uploads where data gets corrupted or lost during the transform→upload→redownload cycle. This test ensures that:

1. **Transform → Retransform Parity**: Data transformed to simplified format and back maintains exact structure
2. **Weight, Reps, Sets Preservation**: Small modifications (weight changes, rep adjustments, etc.) survive the round-trip
3. **Complex Structures Survive**: Repeat groups, heart rate zones, and multi-step exercises are preserved
4. **All Step Types Are Preserved**: Warmup, cooldown, rest, recovery, exercise, and repeat steps all maintain their properties

## Test Structure

### Main Test Scenarios

#### 1. **E2E: Full Upload Cycle - Data Integrity**

Tests that complete workflow maintains data integrity:

```
Initial Raw → Transform → Retransform → Compare with Initial Raw
```

**Key Tests:**
- `should maintain exact parity through transform -> retransform -> upload -> redownload cycle`
  - Verifies the complete cycle without any modifications
  - Compares initial and final raw workouts field by field
  
- `should preserve workout with repeat groups through full cycle`
  - Tests complex nested structures (RepeatGroupDTO)
  - Verifies repeat count, nested steps, and step order

#### 2. **E2E: Upload Cycle with Small Modifications**

Tests that modifications persist through the cycle:

- **Weight Modifications**
  - Increase weight by 10%
  - Verify the modification is preserved and proportionally scaled
  - Test allows 1% rounding tolerance

- **Reps Modifications**
  - Change reps from 8 to 12
  - Verify endConditionValue matches new rep count

- **Exercise Name Modifications**
  - Change exercise from BARBELL_SQUAT to DUMBBELL_SQUAT
  - Verify old exercise doesn't exist in final output

- **Multiple Simultaneous Modifications**
  - Bench press: +25% weight, -2 reps
  - Squat: -10% weight, +2 reps
  - Verify all modifications applied independently

#### 3. **E2E: Mock API Integration**

Verifies the mocked Garmin API:

- Successfully creates workouts in mock mode
- Validates workouts before upload attempt
- Tests both valid and invalid workout structures

#### 4. **Data Structure Preservation**

Tests specific data preservation scenarios:

- **All Step Types**: Warmup, Exercise, Rest, Recovery, Cooldown
  - Verifies each step type survives transform → retransform
  - Tests that rest steps (merged during transform) are re-expanded during retransform

- **Heart Rate Zone Targets**
  - Tests preservation of HR zone boundaries
  - Verifies target value encoding/decoding

## How the Test Works

### Transform Pipeline

```typescript
           Transform              Retransform
Raw JSON ───────────────────→ SimplifiedWorkout ─────────────────→ GarminDetail
   ↑                                                                      ↓
   └──────────────────── Compare (should match) ←──────────────────────┘
```

### Data Comparison Logic

The test uses `compareRawWorkouts()` which validates:

1. **Metadata**: name, description, sport type
2. **Segment Count**: number of workout segments
3. **Step Count**: steps per segment (must match)
4. **Step Details For Each Step**:
   - Step type (warmup, exercise, etc.)
   - Exercise name
   - End condition type (reps, time, distance)
   - End condition value
   - Weight (with 1% rounding tolerance)
   - Target type and values (HR zones, pace zones, etc.)

## Running the Tests

### Standard Mode (with Mocks) - Default

By default, all tests run with **mocked Garmin API** calls - no actual network requests are made.

#### Run Only Upload Cycle Tests
```bash
npm test -- src/__tests__/workoutEditor.upload-cycle.test.ts
```

#### Run with Verbose Output
```bash
npm test -- src/__tests__/workoutEditor.upload-cycle.test.ts --verbose
```

#### Run All Tests (Including Upload Cycle)
```bash
npm test
```

#### Debug a Specific Test
```bash
npm test -- src/__tests__/workoutEditor.upload-cycle.test.ts -t "should maintain exact parity"
```

### Real API Mode - Using Actual Garmin API

⚠️ **Warning**: Real API mode will create actual workouts in your Garmin account!

To run tests against the **real Garmin API** instead of mocks:

#### Prerequisites
1. Valid Garmin Connect credentials
2. Network connectivity
3. Understanding that workouts will be created and (hopefully) deleted

#### Method 1: Using the convenience script (Recommended)
```bash
# Set credentials
export GARMIN_EMAIL=your.email@example.com
export GARMIN_PASSWORD=your_password

# Run the script
./scripts/test-real-api.sh
```

The script will:
- Verify credentials are set
- Show a warning prompt
- Run tests with real API
- Provide colored output of the results

#### Method 2: Manual execution
```bash
# Set credentials and flag
export USE_REAL_GARMIN_API=true
export GARMIN_EMAIL=your.email@example.com
export GARMIN_PASSWORD=your_password

# Run tests
npm test -- src/__tests__/workoutEditor.upload-cycle.test.ts
```

#### What Happens in Real API Mode

When `USE_REAL_GARMIN_API=true`:

1. **Test workouts are uploaded** to your actual Garmin Connect account
   - Each test workout has a unique timestamped name (e.g., "Test Workout 1709345678901")
   
2. **Cleanup is automatic** (usually)
   - Tests track all created workout IDs
   - `afterEach()` hook deletes workouts after each test
   - If tests crash, orphaned workouts may remain

3. **Additional tests run**:
   - ✅ Upload → Download cycle verification
   - ✅ Modification persistence through real API
   - These tests are **skipped** in mock mode

4. **Delays are added**:
   - 2-second delay after upload before download
   - Allows Garmin servers to process the workout

#### Real API Test Scenarios

The following additional tests run **only** in real API mode:

**Test 1: Upload workout to real Garmin API and download it back**
- Uploads a test workout
- Waits for server processing
- Downloads the same workout by ID
- Compares initial vs downloaded structure
- Verifies data integrity through real API

**Test 2: Modify workout, upload, and verify changes persist**
- Modifies a workout (e.g., increase weight by 50%)
- Uploads to Garmin
- Downloads back
- Verifies the modification persisted

#### Cleanup and Safety

**Automatic Cleanup:**
```typescript
afterEach(async () => {
  if (USE_REAL_API && createdWorkoutIds.length > 0) {
    for (const workoutId of createdWorkoutIds) {
      await client.deleteWorkout(workoutId);
    }
  }
});
```

**Manual Cleanup (if tests crash):**
```bash
# List recent workouts
npm run manage-workouts -- list

# Delete orphaned test workouts by ID
npm run manage-workouts -- delete <workoutId>
```

#### Troubleshooting Real API Tests

**Authentication Failures:**
- Verify email/password are correct
- Check if 2FA is enabled (may require session cookies instead)
- Review Garmin Connect API status

**Upload Failures:**
- Check network connectivity
- Verify account has permissions to create workouts
- Check Garmin API rate limits

**Cleanup Failures:**
- Tests will log warnings if deletion fails
- Manually delete orphaned workouts using Garmin Connect web interface
- Or use: `npm run manage-workouts -- delete <workoutId>`

**Timeout Issues:**
- Increase Jest timeout: `jest.setTimeout(60000)`
- Check if Garmin servers are responding slowly
- Verify network latency

## Understanding Test Failures

### Weight Differences
- The test allows 1% tolerance for weight rounding
- Weights are stored in grams (453.59237 per lb) which can cause rounding
- If tolerance is exceeded, the difference will be logged

### Missing Step Types
- Rest steps are **merged** during transform (stored as `restTimeSeconds` on the preceding step)
- They are **re-expanded** during retransform back into separate REST steps
- This is expected behavior and the test accounts for it

### Exercise Name Mismatches
- Categories are derived from exercise names using pattern matching
- Ensure exercise names match Garmin's standard naming (CAPS_WITH_UNDERSCORES)
- Common mappings: `BARBELL_BENCH_PRESS`, `BARBELL_SQUAT`, `DUMBBELL_CURL`, etc.

### Repeat Group Issues
- Repeat groups are flattened during transform but re-created during retransform
- Each repeat iteration gets individual steps in the flat format
- The `repeatGroupIndex` tracks which steps belong to the same repeat

## Key Implementation Details

### Transform (Raw → Simplified)
- **Files**: `src/workoutEditor.ts` - `transformWorkouts()`, `transformWorkoutSteps()`
- **Key Behavior**:
  - Flattens RepeatGroupDTO structures
  - Merges rest steps into preceding exercise steps (`restTimeSeconds`)
  - Converts Garmin IDs to readable keys
  - Converts weights from grams to pounds

### Retransform (Simplified → Garmin)
- **Files**: `src/workoutEditor.ts` - `buildGarminWorkoutDetail()`, `unflattenSteps()`
- **Key Behavior**:
  - Reconstructs RepeatGroupDTO from `repeatGroupIndex` markers
  - Re-expands merged rest steps
  - Converts weights back to grams
  - Rebuilds all type IDs and enums

### Comparison
- **Helper Function**: `compareRawWorkouts()`
- **Tolerance**: 1% for weight values
- **Ignored Fields**: IDs, timestamps, internal references (these regenerate)

## API Modes: Mock vs Real

### Mock API Behavior (Default)

The tests use Jest mocks for the Garmin API when `USE_REAL_GARMIN_API` is not set:

```typescript
jest.mock("@flow-js/garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(function() {
    return {
      login: jest.fn().mockResolvedValue(true),
      createWorkout: jest.fn().mockImplementation(async (workout) => {
        return {
          ...workout,
          workoutId: Math.floor(Math.random() * 1000000) + 10000,
        };
      }),
      deleteWorkout: jest.fn().mockResolvedValue({}),
      // ... other mocked methods
    };
  }),
}));
```

**Mock Mode Characteristics:**
- ✅ Returns the uploaded workout with a new random ID
- ✅ No actual network calls are made
- ✅ Safe for CI/CD pipelines
- ✅ Fast execution (no network latency)
- ✅ No Garmin account required
- ⚠️ Doesn't test actual Garmin API behavior
- ⚠️ Can't verify server-side processing

### Real API Behavior

When `USE_REAL_GARMIN_API=true`, the mock is **disabled** and real `@flow-js/garmin-connect` client is used:

**Real Mode Characteristics:**
- ✅ Tests actual Garmin Connect API
- ✅ Verifies server-side processing
- ✅ Catches API contract changes
- ✅ Tests real upload/download cycle
- ⚠️ Requires valid credentials
- ⚠️ Creates actual data in your account
- ⚠️ Subject to API rate limits
- ⚠️ Network latency affects speed
- ⚠️ Can leave orphaned workouts on test failure

**When to Use Each Mode:**

| Scenario | Mock Mode | Real API Mode |
|----------|-----------|---------------|
| Development / TDD | ✅ Recommended | ❌ Too slow |
| CI/CD Pipeline | ✅ Required | ❌ Security risk |
| Pre-release validation | ⚠️ Quick check | ✅ Full validation |
| Debugging API issues | ❌ Can't reproduce | ✅ See actual behavior |
| Nightly integration tests | ❌ Insufficient | ✅ Ideal use case |

## Debugging Tips

### Enable Debug Output
```bash
DEBUG_WORKOUTS=true npm test -- src/__tests__/workoutEditor.upload-cycle.test.ts
```

This logs:
- Garmin format step details
- Step type IDs
- Target value encoding
- Weight conversions

### Inspect Raw Workouts
Tests save intermediate files to temp directories:
- `initial-raw.json` - Original raw workout from Garmin
- `transformed.json` - Simplified format
- Compare these to understand transform behavior

### Add Console Logging
```typescript
console.log("Initial:", JSON.stringify(initialRaw, null, 2));
console.log("Final:", JSON.stringify(finalRaw, null, 2));
```

## Test Coverage

### Mock Mode Tests (Always Run)
- **Total Tests**: 15
- **Coverage Areas**:
  - ✅ Basic transform cycle - strength training (1 test)
  - ✅ Repeat group structures (1 test)
  - ✅ Weight modifications (1 test)
  - ✅ Reps modifications (1 test)
  - ✅ Exercise name changes (1 test)
  - ✅ Multiple simultaneous changes (1 test)
  - ✅ Mock API integration (2 tests)
  - ✅ Step type preservation (1 test)
  - ✅ Heart rate zone targets (1 test)
  - ✅ Running workout transform cycle (1 test)
  - ✅ Running workout HR zone preservation (1 test)
  - ✅ Running workout HR zone modification (1 test)
  - ✅ Running workout interval duration modification (1 test)
  - ✅ Running workout repeat group preservation (1 test)

### Real API Tests (Only with USE_REAL_GARMIN_API=true)
- **Additional Tests**: 2
- **Coverage Areas**:
  - ✅ Upload to real API and download back (1 test)
  - ✅ Modify workout, upload, and verify persistence (1 test)

### Total Possible Tests
- **Mock Mode**: 15 tests, 2 skipped = **17 total**
- **Real API Mode**: 17 tests = **17 total**

## Related Files

- **Main Test File**: `src/__tests__/workoutEditor.upload-cycle.test.ts`
- **Transformation Logic**: `src/workoutEditor.ts`
  - `transformWorkouts()` - lines ~850
  - `transformWorkoutSteps()` - lines ~400
  - `buildGarminWorkoutDetail()` - lines ~1500
  - `unflattenSteps()` - lines ~1350
- **Type Definitions**: `src/shared/types.ts`
- **Mock Setup**: `src/mocks.setup.ts`

## Future Enhancements

Potential areas to expand this test:

1. **File I/O**: Add actual file write/read cycle to test JSON serialization
2. ~~**Real API**: Create separate integration test that uses real Garmin API~~ ✅ **DONE**
3. **Performance**: Add benchmarks for transform operations
4. **Edge Cases**: Add tests for empty steps, null values, extreme weight values
5. **Backward Compatibility**: Test older workout format compatibility
6. **Concurrent Uploads**: Test rate limiting and parallel upload handling
7. **Error Recovery**: Test what happens when API calls fail mid-cycle
8. **Session Management**: Test token refresh and re-authentication scenarios
