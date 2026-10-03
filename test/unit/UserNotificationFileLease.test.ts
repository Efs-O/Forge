import { describe, expect, it, vi } from 'vitest';
import {
  FILE_DELIVERY_TURN_LIMIT,
  UserNotificationService,
} from '../../src/sidebar/UserNotificationService';

const event = { text: 'caption', imagePath: 'C:/workspace/photo.png' };

describe('UserNotificationService file delivery leases', () => {
  it('charges a grant once and refuses a fifth send from a four-slot lease', async () => {
    const service = new UserNotificationService();
    const sink = vi.fn(async () => 1);
    service.addSink(sink);
    const lease = service.reserveFileDeliveries('c1', 4);

    expect(lease).toMatchObject({ granted: 4, remaining: 1 });
    expect(service.remainingFileDeliveries('c1')).toBe(1);
    expect(await Promise.all(Array.from({ length: 4 }, () => lease.deliver(event)))).toEqual(
      Array.from({ length: 4 }, () => ({ kind: 'queued', chats: 1 })),
    );
    expect(await lease.deliver(event)).toEqual({ kind: 'exhausted' });
    expect(service.remainingFileDeliveries('c1')).toBe(1);
    expect(sink).toHaveBeenCalledTimes(4);
  });

  it('validates requests and grants zero, partial, or capped amounts', () => {
    const service = new UserNotificationService();
    expect(() => service.reserveFileDeliveries('c1', -1)).toThrow(/nonnegative integer/);
    expect(() => service.reserveFileDeliveries('c1', 1.5)).toThrow(/nonnegative integer/);
    expect(service.reserveFileDeliveries('c1', 0)).toMatchObject({ granted: 0, remaining: 5 });
    expect(service.reserveFileDeliveries('c2', 8)).toMatchObject({ granted: 5, remaining: 0 });

    service.reserveFileDeliveries('partial', 3);
    expect(service.reserveFileDeliveries('partial', 4)).toMatchObject({
      granted: 2,
      remaining: 0,
    });
  });

  it('serializes competing reservations with deliverFile against the shared limit', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    const [first, second] = await Promise.all([
      Promise.resolve(service.reserveFileDeliveries('c1', 4)),
      Promise.resolve(service.reserveFileDeliveries('c1', 4)),
    ]);
    expect([first.granted, second.granted]).toEqual([4, 1]);
    expect(service.remainingFileDeliveries('c1')).toBe(0);
    expect((await service.deliverFile({ ...event, conversationId: 'c1' })).kind).toBe('refused');
    expect(await first.deliver(event)).toEqual({ kind: 'queued', chats: 1 });
    expect(await second.deliver(event)).toEqual({ kind: 'queued', chats: 1 });
    expect(service.remainingFileDeliveries('c1')).toBe(0);
  });

  it('keeps attempted sends charged when there are no chats or a sink throws', async () => {
    const onSinkError = vi.fn();
    const service = new UserNotificationService(onSinkError);
    const lease = service.reserveFileDeliveries('c1', 2);
    expect(await lease.deliver(event)).toEqual({ kind: 'queued', chats: 0 });
    expect(service.remainingFileDeliveries('c1')).toBe(FILE_DELIVERY_TURN_LIMIT - 2);
    service.addSink(async () => {
      throw new Error('transport down');
    });
    expect(await lease.deliver(event)).toEqual({ kind: 'queued', chats: 0 });
    expect(onSinkError).toHaveBeenCalledOnce();
    expect(service.remainingFileDeliveries('c1')).toBe(FILE_DELIVERY_TURN_LIMIT - 2);
    expect(await lease.deliver(event)).toEqual({ kind: 'exhausted' });
  });

  it('invalidates leases on reset without affecting another conversation or no-id bucket', async () => {
    const service = new UserNotificationService();
    const sink = vi.fn(async () => 1);
    service.addSink(sink);
    const oldLease = service.reserveFileDeliveries('c1', 3);
    service.reserveFileDeliveries('c2', FILE_DELIVERY_TURN_LIMIT);
    service.reserveFileDeliveries(undefined, FILE_DELIVERY_TURN_LIMIT);

    service.resetTurn('c1');

    expect(await oldLease.deliver(event)).toEqual({ kind: 'stale' });
    expect(sink).not.toHaveBeenCalled();
    expect(service.remainingFileDeliveries('c1')).toBe(FILE_DELIVERY_TURN_LIMIT);
    expect(service.remainingFileDeliveries('c2')).toBe(0);
    expect(service.remainingFileDeliveries(undefined)).toBe(0);
  });

  it('starts a new turn with fresh lease state', async () => {
    const service = new UserNotificationService();
    service.addSink(async () => 1);
    const oldLease = service.reserveFileDeliveries('c1', 5);
    service.resetTurn('c1');
    const freshLease = service.reserveFileDeliveries('c1', 1);
    expect(await oldLease.deliver(event)).toEqual({ kind: 'stale' });
    expect(await freshLease.deliver(event)).toEqual({ kind: 'queued', chats: 1 });
    expect(service.remainingFileDeliveries('c1')).toBe(FILE_DELIVERY_TURN_LIMIT - 1);
  });
});
