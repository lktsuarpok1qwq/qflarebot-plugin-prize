import type { MessageConfiguration } from './messages/templates/config.js';
import type { PluginContext } from '@qqbot/sdk';
import type { OperationReceipt, PointsService } from 'qflarebot-plugin-points';

export type Ctx = PluginContext;
export type Kind = 'POOL';
export type PoolState = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'ARCHIVED';
export type DrawState = 'CREATED' | 'DEBITED' | 'DRAWN' | 'SETTLING' | 'CANCELLING'
    | 'SETTLED' | 'FAILED' | 'REFUNDED' | 'NEEDS_REVIEW';
export type ClaimState = 'LOCKED' | 'PENDING' | 'CLAIMED' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED';
export type StockPolicy = 'RETURN' | 'RETIRE';
export interface Award {
    id: string;
    name: string;
    label: string;
    type: 'NONE' | 'POINTS' | 'PHYSICAL' | 'VIRTUAL_MANUAL';
    weight: number;
    reward: number;
    prizeId?: string;
    claimHours?: number;
    expiry?: StockPolicy;
}
export interface Rules {
    kind: Kind;
    name: string;
    description: string;
    cost: number;
    starts: number;
    ends: number;
    totalLimit: number;
    userLimit: number;
    dailyLimit: number;
    repeat: 'ALLOW' | 'ONCE_PER_POOL';
    awards: Award[];
}
export interface Pool {
    bot_id: string;
    id: string;
    state: PoolState;
    version: number;
    inventory_revision: number;
    rules: string;
}
export interface Prize {
    bot_id: string;
    id: string;
    name: string;
    stock_total: number;
    available: number;
    reserved: number;
    fulfilled: number;
    retired: number;
    version: number;
    deleted: number;
}
export type StockView = Pick<Prize, 'id' | 'name' | 'available' | 'reserved' | 'fulfilled' | 'version' | 'deleted'> & { bound: boolean };
export interface Settings {
    paused: boolean;
    archiveEnabled: boolean;
    retentionMonths: number;
    maxInflight: number;
    maxFacts: number;
    maxPendingBytes: number;
}
export interface Meta {
    bot_id: string;
    facts_count: number;
    pending_bytes: number;
    cursor_secret: string;
    data_revision: number;
    schema_version: number;
    state: string;
    version: number;
    admission_enabled: number;
    admission_revision: number;
    policy: string | null;
    settings: string;
    heartbeat: number;
    lease_token: string | null;
    lease_until: number;
    maintenance_requested: number;
    archive_requested: number;
    cleanup_due: number;
    archive_due: number;
    last_error: string | null;
}
export type Operation = {
    [K in 'burn' | 'credit' | 'reverseOwn']: {
        method: K;
        input: Parameters<PointsService[K]>[0];
        attempts: number;
        outcome?: 'COMMITTED' | 'REJECTED';
        receipt?: OperationReceipt;
        error?: string;
    }
}['burn' | 'credit' | 'reverseOwn'];
export interface DrawBody {
    rules?: Rules;
    results?: Award[];
    inventoryRevision?: number;
    inventoryVersions?: Array<{ id: string; version: number | null }>;
    weights?: Array<{ id: string; weight: number; available: boolean }>;
    ops: Operation[];
    claimId?: string;
    inventoryConflicts: number;
    manualAttempts?: Record<string, number>;
    priorState?: DrawState;
}
export interface Draw {
    bot_id: string;
    id: string;
    short_id: string;
    user_id: string;
    scene: string;
    target: string;
    event_key: string;
    kind: Kind;
    pool_id: string;
    config_version: number;
    admission_revision: number;
    business_day: string;
    created_at: number;
    settled_at: number | null;
    count: number;
    cost: number;
    reward: number;
    state: DrawState;
    qualifies: number;
    winner: number;
    version: number;
    lease_token: string | null;
    lease_until: number;
    retry_at: number;
    expires_at: number;
    error: string | null;
    body: string | null;
    award_ids: string;
    archive_id: string | null;
    archive_pending: string | null;
}
export interface Claim {
    bot_id: string;
    id: string;
    short_id: string;
    draw_id: string;
    user_id: string;
    pool_id: string;
    prize_id: string;
    award: string | null;
    state: ClaimState;
    stock_state: 'RESERVED' | 'RETURNED' | 'FULFILLED' | 'RETIRED';
    obtained_at: number | null;
    expires_at: number | null;
    claimed_at: number | null;
    fulfilled_at: number | null;
    expired_at: number | null;
    cancelled_at: number | null;
    processed_at: number | null;
    version: number;
    details_version: number;
    details: string | null;
    purge_at: number | null;
    note: string | null;
    admin_op: string | null;
    archive_id: string | null;
    archive_pending: string | null;
}
export interface Outcome {
    ok: boolean;
    code: string;
    target?: string;
    version?: number;
    delta?: number;
    stock?: StockView;
    templates?: { version: number; config: MessageConfiguration };
    state?: string;
}
export const TERMINAL = ['SETTLED', 'FAILED', 'REFUNDED'] as const;
export const SOURCE = 'prize';
export const CONTRACT = 'sdk4-points-wallet-20261021';
export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const OPEN_END = 8_640_000_000_000_000;
