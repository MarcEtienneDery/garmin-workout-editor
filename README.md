# Garmin Workout Editor

Extract your recent activities from Garmin and update your next week's workout using AI.

> **⚠️ Authentication Note:** Direct email/password authentication is currently blocked by Garmin. Use the **session cookie method** instead. See [AUTH_ISSUES.md](AUTH_ISSUES.md) and [GET_SESSION.md](GET_SESSION.md) for solutions.

## Features

- Extract recent activities from Garmin account
- Save activities to JSON file
- Update next week's workout using AI
- Comprehensive test suite with unit and integration tests
- Mock mode for testing without real Garmin credentials
- **Session cookie authentication** (works even with 2FA enabled)

## Setup

### Quick Start (Session Cookie - Recommended)

1. Install dependencies:
```bash
npm install
```

2. Get your session cookie (see [GET_SESSION.md](GET_SESSION.md)):
```bash
# Add to .env file:
GARMIN_SESSION_COOKIE="your_cookie_from_browser"
```

3. Run:
```bash
npm run extract-activities
```

### Alternative: Email & Password (If no 2FA)

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your Garmin credentials:
```
GARMIN_EMAIL=your_email@example.com
GARMIN_PASSWORD="your_password"
```

3. Run:
```bash
npm run extract-activities
```

**Note:** If this fails with "You have been blocked", use the session cookie method instead.

## Usage

### Extract Activities (with Real Garmin Account)

Extract your recent Garmin activities and save to JSON:

```bash
npm run extract-activities
```

This will create an `activities.json` file with your recent 20 activities from your real Garmin Connect account.

You can specify a custom limit and output path:
```bash
npm run extract-activities 30 ./custom/path/activities.json
```

**Requirements**:
- `.env` file with `GARMIN_EMAIL` and `GARMIN_PASSWORD`
- Valid Garmin Connect account credentials
- No 2-factor authentication enabled (support coming soon)

### Extract Activities (Mock Mode - Testing)

Run extraction with mock data without real credentials:

```bash
MOCK_MODE=true npm run extract-activities
```

Or with command-line flag:
```bash
npm run extract-activities -- --mock
```

This generates realistic test data for development and testing purposes.

## Testing

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm test:watch
```

### Generate coverage report
```bash
npm run test:coverage
```

### Test Coverage

The project includes:
- **Unit Tests**: Core functionality and edge cases
- **Integration Tests**: End-to-end workflows and data integrity

Current coverage:
- Statements: ~52%
- Functions: ~70%
- Branches: ~37%

## Project Structure

```
src/
├── garminExtractor.ts      # Main Garmin API client with real endpoints
├── types.ts                # TypeScript interfaces
├── extractActivities.ts    # CLI entry point
├── index.ts                # Main export
└── __tests__/
    ├── garminExtractor.test.ts          # Unit tests
    ├── garminExtractor.integration.test.ts  # Integration tests
    └── types.test.ts                    # Type tests
data/
└── activities.json         # Extracted activities (generated)
docs/
└── GARMIN_API.md          # Detailed API documentation
```

## Real Garmin API Endpoints

The application uses the official Garmin Connect API endpoints:

- **Primary**: `https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities`
- **Authentication**: `https://sso.garmin.com/sso/signin`

For detailed endpoint information and troubleshooting, see [GARMIN_API.md](GARMIN_API.md).

## Activity Data Structure

Each extracted activity includes:
- `id`: Unique activity identifier
- `activityName`: Name of the activity
- `activityType`: Type (running, cycling, swimming, strength)
- `startTime`: ISO 8601 timestamp
- `duration`: Duration in seconds
- `distance`: Distance in kilometers
- `calories`: Calories burned
- `avgHR`: Average heart rate
- `maxHR`: Maximum heart rate
- `elevation`: Elevation gain in meters
- `avgCadence`: Average cadence
- `avgSpeed`: Average speed
- `maxSpeed`: Maximum speed