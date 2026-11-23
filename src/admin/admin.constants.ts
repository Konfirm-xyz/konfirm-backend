/**
 * Single page-size cap for every admin list endpoint (#330). Previously
 * admin.schemas.ts used 1000 and AdminFeesService used 200 with no stated
 * reason; 200 is the value that was actually live, so it is the shared one.
 */
export const ADMIN_MAX_LIMIT = 200;
