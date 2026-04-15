import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Amplify } from 'aws-amplify'
// @ts-ignore - Type definitions have package.json exports issue
import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import '@cloudscape-design/global-styles/index.css'
import { awsconfig } from './aws-config'
import App from './App.tsx'

// Configure AWS Amplify with Cognito settings
Amplify.configure(awsconfig)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Authenticator>
      {({ signOut, user }: { signOut?: () => void; user?: any }) => (
        <App signOut={signOut} user={user} />
      )}
    </Authenticator>
  </StrictMode>,
)
