#!/bin/bash
# Script to run upload cycle integration tests against the REAL Garmin API
#
# Usage:
#   ./scripts/test-real-api.sh
#
# Required: Set GARMIN_EMAIL and GARMIN_PASSWORD environment variables first:
#   export GARMIN_EMAIL=your.email@example.com
#   export GARMIN_PASSWORD=your_password
#   ./scripts/test-real-api.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Real Garmin API Integration Test${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

# Check if credentials are set
if [ -z "$GARMIN_EMAIL" ] || [ -z "$GARMIN_PASSWORD" ]; then
    echo -e "${RED}ERROR: Garmin credentials not set${NC}"
    echo ""
    echo "Please set the following environment variables:"
    echo "  export GARMIN_EMAIL=your.email@example.com"
    echo "  export GARMIN_PASSWORD=your_password"
    echo ""
    echo "Then run this script again."
    exit 1
fi

echo -e "${GREEN}✓ Credentials found${NC}"
echo -e "  Email: ${GARMIN_EMAIL}"
echo ""

# Warn about real API usage
echo -e "${YELLOW}⚠ WARNING:${NC} This will use the REAL Garmin API!"
echo "  - Workouts will be created in your account"
echo "  - Tests will attempt to clean up (delete created workouts)"
echo "  - API rate limits apply"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo -e "${GREEN}Running tests with real API...${NC}"
echo ""

# Run the tests with real API flag
export USE_REAL_GARMIN_API=true
npm test -- src/__tests__/workoutEditor.upload-cycle.test.ts

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Tests completed!${NC}"
echo -e "${GREEN}========================================${NC}"
