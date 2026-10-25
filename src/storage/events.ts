import type { Session } from '@qqbot/sdk';
import { ensure, text } from './db.js';

export function eventKey(session: Session): string {
    ensure((session.scene === 'c2c' || session.scene === 'group') && session.userId && session.targetId, 'IDENTITY_REQUIRED');
    text(session.userId, 128);
    text(session.targetId, 128);
    const id = session.interaction?.id || session.messageId;
    ensure(id, 'EVENT_ID_REQUIRED');
    text(id, 512);

    return JSON.stringify([session.scene, session.targetId, session.userId, session.rawType, id]);
}
