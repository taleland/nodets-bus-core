import { type FactoryProvider } from '@nestjs/common';
import { type BusInstance } from '@node-ts/bus-core';
import { NODETS_BUS_CORE_SYMBOLS } from './symbols.js';

export type GetBus = (token: string) => BusInstance;

export const bus: FactoryProvider<GetBus> = {
  provide: NODETS_BUS_CORE_SYMBOLS.getBusInstance,
  useFactory (busMap: Map<string, BusInstance>) {
    return (token: string) => {
      const busInstance = busMap.get(token);

      if (busInstance === null || busInstance === undefined) {
        throw new Error('bus not initialized');
      }

      return busInstance;
    };
  },
  inject: [NODETS_BUS_CORE_SYMBOLS.busMap],
};
