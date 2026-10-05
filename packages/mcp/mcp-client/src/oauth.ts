import type { Context } from '@deepseek-ai/cordis'
import type { OAuthClientProvider as SdkOAuthClientProvider, AuthResult } from '@modelcontextprotocol/client'

export type { AuthResult, OAuthDiscoveryState } from '@modelcontextprotocol/client'
export type OAuthClientProvider = SdkOAuthClientProvider & { forTransport?(): SdkOAuthClientProvider }
export type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client'

/** OAuth is opt-in on the existing HTTP MCP connection. Secrets remain credential references. */
export interface McpOAuthConfig {
  clientId?: string
  clientSecretEnv?: string
  scope?: string
  redirectUri?: string
}

/** Product-owned credential/UI adapter; native MCP keeps sole ownership of transports and tools. */
export interface McpOAuthBridgeRequest {
  owner: Context
  serverName: string
  serverUrl: string
  config: McpOAuthConfig
  authorize(provider: OAuthClientProvider, code?: string): Promise<AuthResult>
  control(action: 'pause' | 'reconnect'): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'mcp/oauth-provider'(request: McpOAuthBridgeRequest, next: () => Promise<OAuthClientProvider | undefined>): Promise<OAuthClientProvider | undefined>
  }
}
