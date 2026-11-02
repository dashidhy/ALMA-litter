/** ALMA-owned semantic notices, never Provider prose or credential material. */
export const AUTH_NOTICE_CODES = [
  "authorization_invalid", "storage_unreadable_reset", "authorization_removed",
  "replacement_cleanup_reset", "authorization_cancelled", "cancellation_cleanup_failed",
  "recovery_failed", "inspection_unavailable_retained", "authorization_incomplete_reset",
  "authorization_unconfirmed", "task_cleanup_unconfirmed", "credential_save_failed_reset",
  "auth_cleanup_unconfirmed", "storage_cleanup_failed", "state_save_failed_reset",
  "authorized_catalog_usage_unavailable", "authorized_catalog_unavailable", "authorized_usage_unavailable", "authorized",
] as const;
export type AuthNoticeCode = (typeof AUTH_NOTICE_CODES)[number];
