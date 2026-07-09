// SlackUserResolver — Slack users.info を使った UserResolver 実装。
//
// WebClient には直接依存せず最小 IF (UsersInfoClient) を受け取る
// (テストでフェイク注入しやすくするため)。

import type { UserResolver } from "../user-resolver.js";

/** users.info が返す最小の形。WebClient の型に直接依存しないための最小 IF */
export interface UsersInfoClient {
  usersInfo(userId: string): Promise<{
    user?: {
      profile?: { display_name?: string };
      real_name?: string;
      name?: string;
    };
  }>;
}

/** Slack users.info を使った UserResolver 実装。
 * 解決順: profile.display_name (空文字は無視) -> real_name -> name -> null。
 * 結果は Map に無期限キャッシュする (失敗時の null も含む)。 */
export class SlackUserResolver implements UserResolver {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly client: UsersInfoClient) {}

  async resolve(userId: string): Promise<string | null> {
    const cached = this.cache.get(userId);
    if (cached !== undefined) return cached;

    let resolved: string | null;
    try {
      const { user } = await this.client.usersInfo(userId);
      const displayName = user?.profile?.display_name;
      resolved =
        (displayName !== undefined && displayName !== ""
          ? displayName
          : undefined) ??
        user?.real_name ??
        user?.name ??
        null;
    } catch {
      resolved = null;
    }
    this.cache.set(userId, resolved);
    return resolved;
  }
}
