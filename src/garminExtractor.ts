import axios, { AxiosInstance } from "axios";
import * as fs from "fs";
import * as path from "path";
import { CookieJar } from "tough-cookie";
import { ExtractedActivities } from "./types";

class GarminExtractor {
  private email: string;
  private password: string;
  private client: AxiosInstance;
  private SESSION_ID: string | null = null;
  private mockMode: boolean = false;
  private cookies: { [key: string]: string } = {};
  private cookieJar: CookieJar;

  // Garmin API endpoints
  private readonly GARMIN_BASE_URL =
    "https://www.garmin.com";
  private readonly GARMIN_SSO_URL =
    "https://sso.garmin.com/sso";
  private readonly GARMIN_SIGNIN_URL =
    "https://sso.garmin.com/sso/signin";
  private readonly GARMIN_CONNECT_API_URL =
    "https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities";

  constructor(email: string, password: string, mockMode: boolean = false) {
    this.email = email;
    this.password = password;
    this.mockMode = mockMode;
    this.cookieJar = new CookieJar();

    this.client = axios.create({
      withCredentials: true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // Add request interceptor to add cookies
    this.client.interceptors.request.use(async (config) => {
      const url = config.url;
      if (url) {
        const cookieString = await this.getCookieStringForUrl(url);
        if (cookieString) {
          config.headers.Cookie = cookieString;
        }
      }
      return config;
    });

    // Add response interceptor to capture and store cookies
    this.client.interceptors.response.use(
      async (response) => {
        const setCookieHeader = response.headers["set-cookie"];
        const url = response.config.url;
        if (setCookieHeader && url) {
          const cookies = Array.isArray(setCookieHeader)
            ? setCookieHeader
            : [setCookieHeader];
          for (const cookie of cookies) {
            try {
              await this.cookieJar.setCookie(cookie, url);
            } catch (e) {
              // Cookie parsing might fail for some cookies, that's ok
            }
          }
        }
        return response;
      },
      (error) => Promise.reject(error)
    );
  }

  /**
   * Get cookies for a specific URL from the cookie jar
   */
  private async getCookieStringForUrl(url: string): Promise<string> {
    try {
      const cookies = await this.cookieJar.getCookies(url);
      return cookies.map(c => `${c.key}=${c.value}`).join("; ");
    } catch (e) {
      return "";
    }
  }

  /**
   * Get the current cookies as a Cookie header string
   */
  private getCookieString(): string {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  /**
   * Log response details for debugging
   */
  private logResponseDebug(label: string, response: any): void {
    console.log(`\n  🔍 DEBUG [${label}]:`);
    console.log(`     Status: ${response.status}`);
    console.log(`     Headers: ${JSON.stringify(Object.keys(response.headers)).substring(0, 100)}`);
    console.log(`     Data type: ${typeof response.data}`);
    if (typeof response.data === "string") {
      const preview = response.data.substring(0, 200).replace(/\n/g, " ");
      console.log(`     Data preview: ${preview}`);
      // Log error messages if present
      if (response.data.includes("Invalid") || response.data.includes("invalid")) {
        console.log("     ⚠️  Response contains 'Invalid'");
      }
      if (response.data.includes("error") || response.data.includes("Error")) {
        console.log("     ⚠️  Response contains error");
      }
      if (response.data.includes("MFA") || response.data.includes("2fa")) {
        console.log("     ⚠️  Response mentions MFA/2FA");
      }
    } else if (response.data && typeof response.data === "object") {
      console.log(`     Data keys: ${Object.keys(response.data).slice(0, 5).join(", ")}`);
      if (response.data.error) {
        console.log(`     Error: ${response.data.error}`);
      }
    }
  }

  /**
   * Authenticate with Garmin using SSO
   */
  async authenticate(): Promise<boolean> {
    try {
      console.log("🔐 Authenticating with Garmin...");
      
      // Check if we have a session cookie provided directly
      const sessionCookie = process.env.GARMIN_SESSION_COOKIE;
      if (sessionCookie) {
        console.log("  ✓ Using provided session cookie");
        try {
          // Set the cookie in the jar
          await this.cookieJar.setCookie(`sessionCookie=${sessionCookie}`, "https://connect.garmin.com");
        } catch (e) {
          // Cookie might not parse, but that's ok
        }
        
        // Test if the session works
        const testResponse = await this.client.get(
          "https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?limit=1",
          {
            headers: {
              "Cookie": `sessionCookie=${sessionCookie}`,
              "X-Requested-With": "XMLHttpRequest",
            },
            validateStatus: () => true,
          }
        );

        if (testResponse.status === 200 && typeof testResponse.data !== "string") {
          console.log("✅ Session cookie authentication successful!");
          return true;
        }
        if (testResponse.status === 200 && typeof testResponse.data === "string" && !testResponse.data.includes("<!DOCTYPE")) {
          console.log("✅ Session cookie authentication successful!");
          return true;
        }
        console.warn("  ⚠️  Session cookie didn't work, trying normal auth...");
      }

      // Try new authentication method first (modern Garmin Connect)
      console.log("  🔄 Attempting modern authentication...");
      const modernAuthSuccess = await this.tryModernAuthentication();
      if (modernAuthSuccess) {
        console.log("✅ Authentication successful!");
        return true;
      }

      // Fall back to legacy SSO if modern fails
      console.log("  🔄 Falling back to legacy SSO...");
      return await this.tryLegacySSO();
    } catch (error: any) {
      console.error("❌ Authentication error:", error.message);
      return false;
    }
  }

  /**
   * Try modern Garmin Connect authentication
   */
  private async tryModernAuthentication(): Promise<boolean> {
    try {
      // Step 1: Get the main Garmin Connect page (initialize cookies)
      const initResponse = await this.client.get("https://connect.garmin.com/modern", {
        validateStatus: () => true,
      });
      console.log(`     Initialized session (status: ${initResponse.status})`);

      // Step 2: Try direct API authentication using the new endpoint
      const authUrl = "https://connect.garmin.com/modern/proxy/auth/login";
      const credentials = {
        login: this.email,
        password: this.password,
        rememberMe: true,
      };

      const authResponse = await this.client.post(authUrl, JSON.stringify(credentials), {
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        validateStatus: () => true,
      });

      console.log(`     Auth endpoint response: ${authResponse.status}`);
      this.logResponseDebug("Modern auth", authResponse);

      if (authResponse.status === 200) {
        // Check if we got a valid response
        if (typeof authResponse.data === "object" && authResponse.data.uid) {
          console.log(`     ✓ Authenticated as UID: ${authResponse.data.uid}`);
          return true;
        } else if (typeof authResponse.data === "string" && authResponse.data.includes("uid")) {
          console.log("     ✓ Authentication successful");
          return true;
        }
      }

      return false;
    } catch (e) {
      console.log(`     Modern auth failed: ${e}`);
      return false;
    }
  }

  /**
   * Try legacy SSO authentication
   */
  private async tryLegacySSO(): Promise<boolean> {
    try {
      // Step 1: Initialize session by visiting connect.garmin.com
      const initResponse = await this.client.get("https://connect.garmin.com/modern", {
        validateStatus: () => true,
      });
      console.log(`     Initialized Garmin Connect (status: ${initResponse.status})`);

      // Step 2: Get the signin page - this is crucial to get initial cookies
      console.log(`     Getting SSO signin page...`);
      const signInPageResponse = await this.client.get(this.GARMIN_SIGNIN_URL, {
        validateStatus: () => true,
      });
      console.log(`     Got signin page (status: ${signInPageResponse.status})`);

      // Wait a moment before posting to let server settle
      await new Promise(r => setTimeout(r, 500));

      // Step 3: Now post credentials - the cookies from the signin page should be included via the interceptor
      const paramSets: Array<Record<string, string>> = [
        {
          email: this.email,
          password: this.password,
          embed: "true",
          service: "https://connect.garmin.com/modern",
        },
        {
          email: this.email,
          password: this.password,
          embed: "true",
          service: "https://connect.garmin.com",
        },
      ];

      for (let i = 0; i < paramSets.length; i++) {
        const params = new URLSearchParams(paramSets[i]);
        console.log(`     Trying SSO variant ${i + 1}...`);

        const loginResponse = await this.client.post(this.GARMIN_SIGNIN_URL, params, {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": this.GARMIN_SIGNIN_URL,
            "Origin": "https://sso.garmin.com",
          },
          maxRedirects: 0,
          validateStatus: () => true,
        });

        console.log(`       Login response: ${loginResponse.status}`);
        
        if (loginResponse.status === 403) {
          const errorCheck = loginResponse.data.includes("blocked") ? " (blocked)" : "";
          console.log(`       ⚠️  Got 403${errorCheck}`);
        }

        if (loginResponse.status === 302) {
          // 302 redirect usually means successful login
          console.log(`     ✓ Got 302 redirect (success indicator)`);
          return true;
        }

        if (loginResponse.status === 200) {
          // Check if we actually got authenticated
          const testResponse = await this.client.get(
            "https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?limit=1",
            {
              headers: {
                "X-Requested-With": "XMLHttpRequest",
              },
              validateStatus: () => true,
            }
          );

          if (testResponse.status === 200 && typeof testResponse.data !== "string") {
            console.log(`     ✓ SSO variant ${i + 1} successful - API accessible`);
            return true;
          }
          if (testResponse.status === 200 && typeof testResponse.data === "string" && !testResponse.data.includes("<!DOCTYPE")) {
            console.log(`     ✓ SSO variant ${i + 1} successful - got JSON`);
            return true;
          }
        }
      }

      console.log("     All SSO variants failed");
      return false;
    } catch (e) {
      console.log(`     Legacy SSO error: ${e}`);
      return false;
    }
  }

  /**
   * Generate mock activities for testing
   */
  private generateMockActivities(limit: number): any[] {
    const activityTypes = ["running", "cycling", "swimming", "strength"];
    const activities: any[] = [];

    for (let i = 0; i < limit; i++) {
      const daysAgo = Math.floor(Math.random() * 30);
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);

      activities.push({
        activityId: `activity-${i + 1}`,
        activityName: `Activity ${i + 1}`,
        activityType: { typeKey: activityTypes[i % activityTypes.length] },
        startTimeInSeconds: Math.floor(date.getTime() / 1000),
        durationInSeconds: Math.floor(Math.random() * 3600) + 600, // 10 min - 1 hour
        distance: Math.floor(Math.random() * 50000) / 1000, // 0-50km
        calories: Math.floor(Math.random() * 800) + 200,
        avgHeartRate: Math.floor(Math.random() * 100) + 100,
        maxHeartRate: Math.floor(Math.random() * 200) + 150,
        avgCadence: Math.floor(Math.random() * 180) + 80,
        averageSpeed: Math.floor(Math.random() * 25000) / 1000,
        maxSpeed: Math.floor(Math.random() * 40000) / 1000,
        elevation: Math.floor(Math.random() * 500),
      });
    }

    return activities;
  }

  /**
   * Fetch recent activities from Garmin
   */
  async fetchActivities(limit: number = 20): Promise<any[]> {
    try {
      console.log(`📥 Fetching last ${limit} activities from Garmin...`);

      if (this.mockMode) {
        return this.generateMockActivities(limit);
      }

      // Use the correct Garmin Connect API endpoint
      const response = await this.client.get(
        this.GARMIN_CONNECT_API_URL,
        {
          params: {
            limit: limit,
            start: 0,
          },
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "NK": "NT", // Garmin Connect requires these headers
            "Cookie": this.getCookieString(),
            "Referer": "https://connect.garmin.com/modern/activities",
          },
          validateStatus: () => true,
        }
      );

      console.log(`📊 API Response status: ${response.status}`);
      
      // Debug: log response type and structure
      if (response.status === 200) {
        console.log(`📋 Response type: ${typeof response.data}, is Array: ${Array.isArray(response.data)}`);
        if (typeof response.data === "string") {
          console.log(`📄 Response preview: ${response.data.substring(0, 200)}`);
        } else if (response.data && typeof response.data === "object") {
          console.log(`📄 Response keys: ${Object.keys(response.data).join(", ")}`);
        }
      }

      if (response.status === 200 && response.data) {
        if (Array.isArray(response.data)) {
          console.log(`✅ Retrieved ${response.data.length} activities`);
          return response.data;
        } else if (response.data.activities && Array.isArray(response.data.activities)) {
          console.log(`✅ Retrieved ${response.data.activities.length} activities`);
          return response.data.activities;
        }
      }

      console.warn(
        `⚠️  Unexpected response format (status ${response.status}), falling back to alternative endpoint...`
      );
      return await this.fetchActivitiesAlternative(limit);
    } catch (error: any) {
      console.warn(
        "⚠️  Primary API failed, attempting alternative endpoint..."
      );
      return await this.fetchActivitiesAlternative(limit);
    }
  }

  /**
   * Alternative method to fetch activities (for testing/fallback)
   */
  private async fetchActivitiesAlternative(limit: number): Promise<any[]> {
    try {
      // Try with different API path variations
      const alternatives = [
        `https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities?limit=${limit}&start=0`,
        `https://www.garmin.com/proxy/activitylist-service/activities/search/activities?limit=${limit}&start=0`,
        `https://connect.garmin.com/web-api/activities?limit=${limit}&start=0`,
      ];

      for (const url of alternatives) {
        try {
          const response = await this.client.get(url, {
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "NK": "NT",
              "Cookie": this.getCookieString(),
              "Referer": "https://connect.garmin.com/modern/activities",
            },
            validateStatus: () => true,
          });

          console.log(`  Trying ${url.split("/").slice(-1)[0]}... (status: ${response.status})`);

          if (response.status === 200 && response.data) {
            const activities = Array.isArray(response.data) 
              ? response.data 
              : response.data.activities || [];
            
            if (activities.length > 0) {
              console.log(`✅ Retrieved ${activities.length} activities from alternative endpoint`);
              return activities;
            }
          }
        } catch (e) {
          // Continue to next alternative
        }
      }

      console.error("❌ Failed to fetch activities from all endpoints");
      return [];
    } catch (error) {
      console.error("❌ Failed to fetch activities:", error);
      return [];
    }
  }

  /**
   * Transform raw Garmin activities to our format
   */
  private transformActivities(rawActivities: any[]): any[] {
    return rawActivities.map((activity: any) => ({
      id: activity.activityId || activity.id,
      activityName: activity.activityName || "Unknown Activity",
      activityType: activity.activityType?.typeKey || activity.activityType,
      startTime: activity.startTimeInSeconds
        ? new Date(activity.startTimeInSeconds * 1000).toISOString()
        : activity.startTime,
      duration: activity.durationInSeconds || 0,
      distance: activity.distance ? activity.distance / 1000 : 0, // Convert to km
      calories: activity.calories || 0,
      avgHR: activity.avgHeartRate || activity.averageHeartRate,
      maxHR: activity.maxHeartRate,
      avgPace: activity.avgPace,
      maxPace: activity.maxPace,
      elevation: activity.elevation || activity.elevationGain,
      avgCadence: activity.avgCadence || activity.averageCadence,
      avgSpeed: activity.avgSpeed || activity.averageSpeed,
      maxSpeed: activity.maxSpeed,
    }));
  }

  /**
   * Save activities to JSON file
   */
  async saveActivitiesToFile(
    activities: any[],
    outputPath: string = "./data/activities.json"
  ): Promise<void> {
    try {
      const data: ExtractedActivities = {
        extractedAt: new Date().toISOString(),
        totalActivities: activities.length,
        activities: this.transformActivities(activities),
      };

      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
      console.log(`✅ Activities saved to ${outputPath}`);
    } catch (error) {
      console.error("❌ Error saving activities:", error);
      throw error;
    }
  }

  /**
   * Extract activities and save to file
   */
  async extract(limit: number = 20, outputPath?: string): Promise<boolean> {
    try {
      // Skip authentication in mock mode
      if (!this.mockMode) {
        // Authenticate
        const authenticated = await this.authenticate();
        if (!authenticated) {
          throw new Error("Failed to authenticate with Garmin");
        }
      } else {
        console.log("🔓 Mock mode: Skipping authentication");
      }

      // Fetch activities
      const activities = await this.fetchActivities(limit);
      if (activities.length === 0) {
        console.warn("⚠️  No activities found");
        return false;
      }

      // Save to file
      await this.saveActivitiesToFile(
        activities,
        outputPath || "./data/activities.json"
      );
      return true;
    } catch (error) {
      console.error("❌ Extraction failed:", error);
      return false;
    }
  }
}

export default GarminExtractor;
