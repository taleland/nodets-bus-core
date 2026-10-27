import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus, type BusInstance } from '@node-ts/bus-core';
import { Test } from '@nestjs/testing';
import { bus, busConfigure, NODETS_BUS_CORE_SYMBOLS, NodeTsBusCoreModule, type BusConfigureFactory, type GetBus } from '../src/index.js';

test('configuration and instance lookups reject unknown tokens and preserve identity', async () => {
  const configuration = Bus.configure();
  const configure = await busConfigure.useFactory(new Map([['billing', configuration]]));
  assert.equal(configure('billing'), configuration);
  assert.throws(() => configure('missing'), /configuration not found/);
  const instances = new Map<string, BusInstance>();
  const getBus = await bus.useFactory(instances);
  assert.throws(() => getBus('billing'), /not initialized/);
  const instance = {} as BusInstance;
  instances.set('billing', instance);
  assert.equal(getBus('billing'), instance);
});

test('separate Nest applications do not share bus maps', async t => {
  const create = () => Test.createTestingModule({ imports: [NodeTsBusCoreModule.forRoot([])] }).compile();
  const first = await create();
  t.after(() => first.close());
  const second = await create();
  t.after(() => second.close());
  const firstMap = first.get<Map<string, BusInstance>>(NODETS_BUS_CORE_SYMBOLS.busMap);
  const secondMap = second.get<Map<string, BusInstance>>(NODETS_BUS_CORE_SYMBOLS.busMap);
  firstMap.set('billing', {} as BusInstance);
  assert.equal(secondMap.has('billing'), false);
  assert.throws(() => second.get<GetBus>(NODETS_BUS_CORE_SYMBOLS.getBusInstance)('billing'), /not initialized/);
  assert.throws(() => first.get<BusConfigureFactory>(NODETS_BUS_CORE_SYMBOLS.busConfigure)('unknown'), /configuration not found/);
});
