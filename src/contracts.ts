import type { MessageConfiguration } from './messages/templates/config.js';
import type { PluginContext } from '@qqbot/sdk';
import type { OperationReceipt, PointsService } from 'qflarebot-plugin-points';

export const SCHEMA = 13;
export type Ctx = PluginContext;
export type Kind = 'POOL';
export type PoolState = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'ARCHIVED';
export type DrawState = 'CREATED' | 'DEBITED' | 'DRAWN' | 'SETTLING' | 'CANCELLING'
    | 'SETTLED' | 'FAILED' | 'REFUNDED' | 'NEEDS_REVIEW';
export const CLAIM_STATES = ['LOCKED', 'PENDING', 'FULFILLED', 'CANCELLED'] as const;
export type ClaimState = typeof CLAIM_STATES[number];
export interface Award {
    id: string;
    name: string;
    label: string;
    type: 'NONE' | 'POINTS' | 'PHYSICAL' | 'VIRTUAL_MANUAL';
    weight: number;
    reward: number;
    prizeId?: string;
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
export const POOL_FIELDS = ['bot_id', 'id', 'state', 'version', 'rules'] as const;
export interface Pool {
    bot_id: string;
    id: string;
    state: PoolState;
    version: number;
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
    capacity_deferred: number;
    cursor_secret: string;
    data_revision: number;
    pool_revision: number;
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
    inventoryVersions?: Array<{ id: string; version: number | null }>;
    weights?: Array<{ id: string; weight: number; available: boolean }>;
    ops: Operation[];
    claimId?: string;
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
    snapshot: string | null;
    claim_id: string | null;
    claim_state: ClaimState | null;
    claim_stock_state: Claim['stock_state'] | null;
    claim_prize_id: string | null;
    claim_award: string | null;
    claim_award_name: string | null;
    claim_created_at: number | null;
    claim_obtained_at: number | null;
    claim_fulfilled_at: number | null;
    claim_cancelled_at: number | null;
    claim_processed_at: number | null;
    claim_version: number;
    claim_note: string | null;
    claim_admin_op: string | null;
    claim_archive_id: string | null;
    claim_archive_pending: string | null;
    award_ids: string;
    pool_name: string;
    result_name: string | null;
    result_award_id: string | null;
    result_prize_id: string | null;
    archive_id: string | null;
    archive_pending: string | null;
    archive_ready: number;
}
export const DRAW_LIST_FIELDS = ['bot_id', 'id', 'short_id', 'user_id', 'scene', 'target', 'event_key', 'kind', 'pool_id',
    'config_version', 'admission_revision', 'business_day', 'created_at', 'settled_at', 'count', 'cost', 'reward', 'state', 'qualifies', 'winner',
    'version', 'lease_token', 'lease_until', 'retry_at', 'expires_at', 'error', 'award_ids', 'pool_name', 'result_name', 'result_award_id', 'result_prize_id', 'archive_id', 'archive_pending'] as const;
export type DrawEvidence = Pick<Draw, typeof DRAW_LIST_FIELDS[number] | 'body' | 'archive_ready'>;
export interface Claim {
    bot_id: string;
    id: string;
    short_id: string;
    draw_id: string;
    user_id: string;
    pool_id: string;
    prize_id: string;
    award: string | null;
    award_name: string;
    created_at: number;
    list_time: number;
    state: ClaimState;
    stock_state: 'RESERVED' | 'RETURNED' | 'FULFILLED' | 'RETIRED';
    obtained_at: number | null;
    fulfilled_at: number | null;
    cancelled_at: number | null;
    processed_at: number | null;
    version: number;
    note: string | null;
    admin_op: string | null;
    archive_id: string | null;
    archive_pending: string | null;
}
export const CLAIM_FIELDS = [
    'bot_id', 'id', 'short_id', 'draw_id', 'user_id', 'pool_id', 'prize_id', 'award', 'state', 'stock_state',
    'award_name', 'created_at', 'list_time', 'obtained_at', 'fulfilled_at', 'cancelled_at', 'processed_at', 'version', 'note', 'admin_op', 'archive_id', 'archive_pending'
] as const satisfies readonly (keyof Claim)[];
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
