import { GarminConnect } from "garmin-connect";

/**
 * Shared Garmin client initialization and authentication
 */
export class GarminClient {
  private email: string;
  private password: string;
  private client: GarminConnect;
  private mockMode: boolean;

  constructor(email: string, password: string, mockMode: boolean = false) {
    this.email = email;
    this.password = password;
    this.mockMode = mockMode;
    this.client = new GarminConnect({
      username: email,
      password: password,
    });
  }

  /**
   * Get the underlying Garmin client (for internal use)
   */
  getClient(): GarminConnect {
    return this.client;
  }

  /**
   * Get the underlying client as any type (for accessing non-typed methods)
   */
  getClientAny(): any {
    return this.client as any;
  }

  /**
   * Check if in mock mode
   */
  isMockMode(): boolean {
    return this.mockMode;
  }

  /**
   * Authenticate with Garmin Connect
   */
  async authenticate(): Promise<boolean> {
    if (this.mockMode) {
      console.log("🔓 Mock mode: Skipping authentication");
      return true;
    }

    try {
      console.log("🔐 Authenticating with Garmin Connect...");

      await this.client.login();

      // Verify authentication by getting user profile
      const userProfile = await this.client.getUserProfile();
      console.log(`✅ Successfully authenticated as: ${userProfile.userName}`);

      return true;
    } catch (error: any) {
      console.error("❌ Authentication error:", error.message);
      return false;
    }
  }

  /**
   * Ensure authenticated (with mock mode support)
   */
  async ensureAuthenticated(): Promise<boolean> {
    if (this.mockMode) {
      console.log("🔓 Mock mode: Skipping authentication");
      return true;
    }

    return this.authenticate();
  }
}

export default GarminClient;
