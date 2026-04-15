/**
 * Hook to determine the current user's role from Cognito User Pool groups.
 * Reads the 'cognito:groups' claim from the ID token JWT.
 */

import { useState, useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import type { UserRole } from '../types';

export interface UserRoleInfo {
  role: UserRole;
  userId: string;
  userName: string;
  isLoading: boolean;
}

export function useUserRole(): UserRoleInfo {
  const [role, setRole] = useState<UserRole>('trainee');
  const [userId, setUserId] = useState('');
  const [userName, setUserName] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadUserInfo() {
      try {
        // Get the ID token to read groups
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken;

        if (idToken) {
          const groups = (idToken.payload['cognito:groups'] as string[]) || [];
          if (groups.includes('admin')) {
            setRole('admin');
          } else {
            setRole('trainee');
          }

          // Use Cognito 'sub' as the stable user ID
          const sub = idToken.payload['sub'] as string;
          if (sub) {
            setUserId(sub);
          }

          // Try to get email or name from token
          const email = idToken.payload['email'] as string;
          const name = idToken.payload['name'] as string;
          setUserName(name || email || '');
        }
      } catch (error) {
        console.error('[useUserRole] Error loading user info:', error);
        // Default to trainee on error
        setRole('trainee');
      } finally {
        setIsLoading(false);
      }
    }

    loadUserInfo();
  }, []);

  return { role, userId, userName, isLoading };
}
