// AWS Amplify Configuration for Cognito Authentication
// Configuration will be injected at build time from CDK outputs

export const awsconfig = {
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID || '',
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID || '',
      identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID || 'us-west-2:d6b3d3bb-d342-4d7a-87fd-07f4aa18ee62',
      loginWith: {
        oauth: {
          domain: import.meta.env.VITE_USER_POOL_DOMAIN || '',
          scopes: ['openid', 'email', 'profile'],
          redirectSignIn: [window.location.origin],
          redirectSignOut: [window.location.origin],
          responseType: 'code' as const,
        },
      },
    },
  },
};
