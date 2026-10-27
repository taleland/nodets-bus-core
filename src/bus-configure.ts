import { type BusConfiguration } from '@node-ts/bus-core';
import { type FactoryProvider } from '@nestjs/common';
import { NODETS_BUS_CORE_SYMBOLS } from './symbols.js';

export type BusConfigureFactory = (token: string) => BusConfiguration;

export const busConfigure: FactoryProvider<BusConfigureFactory> = {
  provide: NODETS_BUS_CORE_SYMBOLS.busConfigure,
  useFactory (busConfigureMap: Map<string, BusConfiguration>) {
    return (token: string) => {
      const config = busConfigureMap.get(token);

      if (config === null || config === undefined) {
        throw new Error('Bus configuration not found for token: ' + token);
      }

      return config;
    };
  },
  inject: [NODETS_BUS_CORE_SYMBOLS.busConfigureMap],
};
