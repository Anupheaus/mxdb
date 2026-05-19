import { defineAction } from '@anupheaus/nexus/common';

interface TestRequest {
  foo: string;
}

interface TestResponse {
  bar: string;
}

interface SignInRequest {
  email: string;
  password: string;
}

export const testAction = defineAction<TestRequest, TestResponse>()('test');
export const signInAction = defineAction<SignInRequest, boolean>()('signIn');
