import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { GenericContainer, Wait } from 'testcontainers';
import { createExample, OrderPlaced } from '../../examples/module-queues.js';

test('RabbitMQ delivers a separate copy to each module queue bound to the event exchange', { timeout: 120000 }, async t => {
  const rabbit = await new GenericContainer('rabbitmq:4-alpine')
    .withEnvironment({ RABBITMQ_DEFAULT_USER: 'test', RABBITMQ_DEFAULT_PASS: 'test' })
    .withExposedPorts(5672)
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .start();
  const cleanup: { close?: () => Promise<void> } = {};
  t.after(async () => {
    try { await cleanup.close?.(); } finally { await rabbit.stop(); }
  });
  const example = await createExample(`amqp://test:test@${rabbit.getHost()}:${rabbit.getMappedPort(5672)}`, `test.${randomUUID()}`);
  cleanup.close = example.close;
  const event = new OrderPlaced('order-123', randomUUID());
  await example.getBus('orders').publish(event);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  t.after(() => clearTimeout(timeout));
  const copies = await Promise.race([
    Promise.all([example.billing.received.promise, example.notifications.received.promise]),
    new Promise<never>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Both module queues must receive the event')), 15000);
    }),
  ]);
  assert.deepEqual(copies.map(copy => copy.eventId), [event.eventId, event.eventId]);
  assert.deepEqual(copies.map(copy => copy.orderId), ['order-123', 'order-123']);
  assert.notEqual(copies[0], copies[1]);
  assert.equal(example.billing.events.length, 1);
  assert.equal(example.notifications.events.length, 1);
});
