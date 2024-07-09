import { Record } from '@anupheaus/common';
import { defineCollection } from '../../../src';
import { fakerEN_GB as faker } from '@faker-js/faker';

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
});

export const officeAddress: AddressRecord = {
  id: 'f05674a2-37a7-425e-9e17-87edc8cf0fbe',
  firstLine: '123 Fake Street',
  secondLine: 'Fakeville',
  townOrCity: 'Faketown',
  county: 'Fakeshire',
  postcode: 'FA1 2KE',
};

export const allAddresses: AddressRecord[] = [
  officeAddress,
  ...Array.ofSize(10000).map(() => ({
    id: Math.uniqueId(),
    firstLine: faker.location.streetAddress(),
    secondLine: faker.location.secondaryAddress(),
    townOrCity: faker.location.city(),
    county: faker.location.county(),
    postcode: faker.location.zipCode(),
  })),
];
