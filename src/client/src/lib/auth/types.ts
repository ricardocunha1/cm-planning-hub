/** The signed-in user, as returned by `GET /api/auth/me`. */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  pictureUrl: string | null;
}
