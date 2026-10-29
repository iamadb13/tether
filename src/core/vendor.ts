/** API constants shared by the real connectors and the mock vendors that imitate them. */
export const WF_API = '/attask/api/v19.0';
export const JIRA_API = '/rest/api/3';
/** Workfront custom fields are addressed with a `DE:` prefix. */
export const SYNC_FLAG = 'DE:Sync to Jira';
export const JIRA_KEY_FIELD = 'DE:Jira Key';
/** Chaos-testing shim header: "the server committed this write, pretend the response was lost". */
export const LOST_RESPONSE_HEADER = 'x-chaos-lost-response';
