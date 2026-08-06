/**
 * OIDC / 外部身份提供方抽象（spec §1 纳入项）。
 * M0 仅定义接口，不实现任何具体 provider（GRILL G3）。
 */
export interface AuthProvider {
  readonly id: string;
  /** 返回跳转授权地址（M1 实现） */
  authorizeUrl?(state: string): string;
  /** 用回调 code 换取用户身份（M1 实现） */
  exchange?(code: string): Promise<{ externalId: string; displayName: string }>;
}

export type AuthProviderRegistry = Record<string, AuthProvider>;
