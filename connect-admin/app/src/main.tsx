import React from 'react';
import ReactDOM from 'react-dom/client';
import '@cloudscape-design/global-styles/index.css';
import { Amplify } from 'aws-amplify';
import App from './App';

// Configure Amplify with environment variables
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_ADMIN_USER_POOL_ID || '',
      userPoolClientId: import.meta.env.VITE_ADMIN_USER_POOL_CLIENT_ID || '',
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);