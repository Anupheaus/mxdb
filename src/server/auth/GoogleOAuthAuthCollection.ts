import type { GoogleOAuthAuthRecord, GoogleOAuthAuthStore } from '@anupheaus/nexus/common';
import type { ServerDb } from '../providers';
import { AuthCollection } from './AuthCollection';

export class GoogleOAuthAuthCollection extends AuthCollection<GoogleOAuthAuthRecord>
  implements GoogleOAuthAuthStore {

  constructor(db: ServerDb) {
    super(db);
  }

  async findByUserId(userId: string): Promise<GoogleOAuthAuthRecord | undefined> {
    const records = await this.findAllByUserId(userId);
    return records[0];
  }
}
