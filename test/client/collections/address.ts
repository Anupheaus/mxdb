import { Record } from '@anupheaus/common';
import { defineCollection, useCollection } from '../../../src';

export interface AddressRecord extends Record {
  firstLine: string;
  secondLine: string;
  townOrCity: string;
  county: string;
  postcode: string;
}

export const address = defineCollection<AddressRecord>({
  name: 'address',
  version: 1,
  indexes: [
    { name: 'first-line-index', fields: ['firstLine'] }
  ],
  onSeed() {
    const { upsert } = useCollection(address);
    upsert(officeAddress);
  },
});

export const officeAddress: AddressRecord = {
  id: 'f05674a2-37a7-425e-9e17-87edc8cf0fbe',
  firstLine: '123 Fake Street',
  secondLine: 'Fakeville',
  townOrCity: 'Faketown',
  county: 'Fakeshire',
  postcode: 'FA1 2KE',
};