// Session API exposed to Gadgets/agents by the Salesforce gatekeeper.
//
// Salesforce stores every piece of CRM data as a record of an *object* (its table): standard
// objects such as Account, Contact, Lead, Opportunity, Case and Task, plus whatever custom
// objects an org has defined (their names end in `__c`). The gatekeeper exposes three grantable
// granularities, each with its own Session interface:
//
//   - SalesforceOrg    — a whole Salesforce org: every object the connected user can see.
//   - SalesforceObject — one object, e.g. every Opportunity the connected user can see.
//   - SalesforceRecord — a single record, e.g. one Account, with its related lists.
//
// `SalesforceRecord` is both a standalone grantable resource AND the object returned when a
// record is opened from an org or object session, so the same capability shape is reused
// everywhere a record is referenced.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Access to an entire Salesforce org: every object and record the connected user can see.
 */
export interface SalesforceOrg {
  /** Returns basic information about the org and the connected user. */
  getMetadata(): Promise<SalesforceOrgMetadata>;

  /**
   * Lists the objects in this org that hold CRM data and can be queried, such as `Account`,
   * `Contact` and any custom objects (names ending in `__c`). Salesforce's internal and system
   * objects are left out.
   */
  listObjects(): Promise<SalesforceObjectSummary[]>;

  /**
   * Opens one object by its API name, e.g. `"Account"` or `"Invoice__c"`.
   *
   * Throws if the org has no such object or the connected user cannot see it.
   */
  getObject(objectName: string): Promise<SalesforceObject>;

  /**
   * Opens one record by its 15- or 18-character Salesforce Id, e.g. `"0015f00000AbCdEfGHI"`.
   * The record's object is derived from the Id, so it need not be given.
   *
   * Throws if no such record exists or the connected user cannot see it.
   */
  getRecord(recordId: string): Promise<SalesforceRecord>;

  /**
   * Searches across objects for `text`, the way Salesforce's global search box does: matches
   * names, numbers, email addresses and other indexed fields, not full record bodies.
   *
   * Results are streamed through the returned cursor — call `next()` repeatedly until it
   * returns `null`.
   */
  search(query: SalesforceSearch): Promise<Cursor<SalesforceRecordSummary>>;

  /**
   * Runs a read-only SOQL query, e.g.
   * `"SELECT Id, Name, Amount FROM Opportunity WHERE StageName = 'Prospecting' ORDER BY Amount DESC"`.
   *
   * Use this for filtering, sorting, aggregates and relationship traversal that
   * {@link listRecords} cannot express. Only `SELECT` queries are accepted; anything else
   * throws. Rows come back as plain objects keyed by the selected field names, with related
   * fields nested (`Account.Name` arrives as `{Account: {Name: ...}}`).
   *
   * Results are streamed through the returned cursor — call `next()` repeatedly until it
   * returns `null`.
   *
   * Throws {@link SalesforceQueryError} when Salesforce rejects the query, with the message it
   * gave, so a malformed query can be corrected and retried.
   */
  query(soql: string): Promise<Cursor<SalesforceRow>>;

  /**
   * Looks up users of this org (up to 50). With a `query`, filters by a case-insensitive
   * name/email/username substring; with no query, returns the first users. Useful for resolving
   * a record owner or a task assignee before creating or updating a record.
   */
  findUsers(query?: string): Promise<SalesforceUser[]>;
}

/**
 * Access to one Salesforce object and every record of it the connected user can see.
 */
export interface SalesforceObject {
  /**
   * Returns this object's fields, picklist values and relationships: what {@link createRecord}
   * and {@link SalesforceRecord.update} will accept, and which values a picklist field allows.
   */
  describe(): Promise<SalesforceObjectDescription>;

  /**
   * Lists records of this object, most-recently-modified first by default.
   *
   * Results are streamed through the returned cursor — call `next()` repeatedly until it
   * returns `null`.
   */
  listRecords(filter?: SalesforceRecordFilter): Promise<Cursor<SalesforceRecordSummary>>;

  /**
   * Searches records of this object for `text`, the way Salesforce's search box does: matches
   * names, numbers, email addresses and other indexed fields, not full record bodies.
   */
  search(query: SalesforceSearch): Promise<Cursor<SalesforceRecordSummary>>;

  /**
   * Opens one record of this object by its 15- or 18-character Salesforce Id.
   *
   * Throws if no such record exists, it belongs to another object, or the connected user cannot
   * see it.
   */
  getRecord(recordId: string): Promise<SalesforceRecord>;

  /**
   * Creates a record of this object. `fields` is keyed by field API name, e.g.
   * `{Name: "Acme Corp", Industry: "Technology"}`; {@link describe} says which fields exist and
   * which are required.
   *
   * Throws {@link SalesforceValidationError} when Salesforce rejects the values, listing the
   * fields at fault so they can be corrected and retried.
   */
  createRecord(fields: SalesforceFieldValues): Promise<SalesforceRecord>;
}

/**
 * Access to a single Salesforce record, its field values, and the related records Salesforce
 * shows beneath it: its contacts, activities, notes and other child records.
 */
export interface SalesforceRecord {
  /** This record's 18-character Salesforce Id. */
  readonly id: string;

  /** The API name of this record's object, e.g. `"Account"`. */
  readonly objectName: string;

  /**
   * Returns this record's field values, keyed by field API name, together with its display name
   * and when it was last modified.
   *
   * By default returns the fields Salesforce shows on the record's page layout. Pass
   * `options.fields` to ask for specific fields instead, including related fields such as
   * `"Owner.Name"`.
   */
  getDetails(options?: SalesforceRecordDetailOptions): Promise<SalesforceRecordDetails>;

  /**
   * Updates field values on this record. `fields` is keyed by field API name; only the fields
   * given are changed.
   *
   * Throws {@link SalesforceValidationError} when Salesforce rejects the values, listing the
   * fields at fault so they can be corrected and retried.
   */
  update(fields: SalesforceFieldValues): Promise<void>;

  /** Moves this record to the Salesforce recycle bin. */
  delete(): Promise<void>;

  /**
   * Names the related lists beneath this record — the child records Salesforce links to it,
   * such as an Account's `Contacts` and `Opportunities` — so {@link listRelated} can be called
   * for one.
   */
  listRelationships(): Promise<SalesforceRelationshipSummary[]>;

  /**
   * Lists the records in one related list, named as {@link listRelationships} reported it.
   *
   * Results are streamed through the returned cursor — call `next()` repeatedly until it
   * returns `null`.
   */
  listRelated(
    relationshipName: string,
    options?: SalesforcePageOptions,
  ): Promise<Cursor<SalesforceRecordSummary>>;

  /**
   * Lists this record's activity timeline: the calls, emails, meetings and tasks logged against
   * it, most recent first. Open tasks and future events come back alongside completed ones,
   * distinguished by {@link SalesforceActivity.status}.
   */
  listActivities(options?: SalesforcePageOptions): Promise<Cursor<SalesforceActivity>>;

  /**
   * Logs a call, task or meeting against this record, the way a rep would from its activity
   * timeline. Assign it with `options.assigneeId`, which defaults to the connected user.
   */
  logActivity(options: SalesforceLogActivityOptions): Promise<void>;

  /** Lists the notes attached to this record, most recent first. */
  listNotes(options?: SalesforcePageOptions): Promise<Cursor<SalesforceNote>>;

  /** Attaches a note to this record. */
  addNote(options: SalesforceAddNoteOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * A stream of results. Call `next()` repeatedly to read successive pages; it returns `null`
 * once there are no more.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** A field value Salesforce can hold. Dates and date-times are ISO 8601 strings. */
export type SalesforceValue = string | number | boolean | null;

/** Field values keyed by field API name, e.g. `{Name: "Acme Corp", NumberOfEmployees: 400}`. */
export type SalesforceFieldValues = Record<string, SalesforceValue>;

/**
 * One row of a {@link SalesforceOrg.query} result, keyed by the names selected. A related field
 * such as `Account.Name` arrives nested, as `{Account: {Name: "Acme Corp"}}`.
 */
export type SalesforceRow = { [field: string]: SalesforceValue | SalesforceRow | null };

/** Basic information about a Salesforce org and the user connected to it. */
export type SalesforceOrgMetadata = {
  /** The org's 18-character Id. */
  id: string;
  /** The org's name, e.g. `"Acme Corporation"`. */
  name: string;
  /** Where the org's UI lives, e.g. `"https://acme.lightning.force.com"`. */
  url: string;
  /** True for a sandbox org rather than production. */
  isSandbox: boolean;
  /** The user whose access this connection carries. */
  connectedUser: SalesforceUser;
};

/** One object in an org, as {@link SalesforceOrg.listObjects} reports it. */
export type SalesforceObjectSummary = {
  /** The object's API name, used everywhere it is referenced, e.g. `"Account"`. */
  name: string;
  /** Its singular label, e.g. `"Account"`. */
  label: string;
  /** Its plural label, e.g. `"Accounts"`. */
  labelPlural: string;
  /** True when the org defined this object rather than Salesforce shipping it. */
  isCustom: boolean;
  /** What the connected user may do with records of this object. */
  permissions: SalesforceObjectPermissions;
};

/** What the connected user may do with records of an object. */
export type SalesforceObjectPermissions = {
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
};

/** An object's fields and relationships, as {@link SalesforceObject.describe} reports them. */
export type SalesforceObjectDescription = SalesforceObjectSummary & {
  fields: SalesforceFieldDescription[];
  relationships: SalesforceRelationshipSummary[];
};

/** One field of an object. */
export type SalesforceFieldDescription = {
  /** The field's API name, the key to use in field values, e.g. `"NumberOfEmployees"`. */
  name: string;
  /** Its label as the Salesforce UI shows it, e.g. `"Employees"`. */
  label: string;
  /**
   * Its type: `"string"`, `"textarea"`, `"int"`, `"double"`, `"currency"`, `"percent"`,
   * `"boolean"`, `"date"`, `"datetime"`, `"email"`, `"phone"`, `"url"`, `"id"`, `"picklist"`,
   * `"multipicklist"` or `"reference"` (a link to another record).
   */
  type: string;
  /** True when a value must be given to create a record. */
  required: boolean;
  /** True when this field's value can be changed after creation. */
  updateable: boolean;
  /** For a picklist, the values it accepts; absent for every other type. */
  picklistValues?: string[];
  /** For a reference field, the objects it may point at, e.g. `["Account"]`. */
  referenceTo?: string[];
  /** The field's help text, when the org set one. */
  description?: string;
};

/** One related list beneath a record: the child records Salesforce links to it. */
export type SalesforceRelationshipSummary = {
  /** The name to pass to {@link SalesforceRecord.listRelated}, e.g. `"Contacts"`. */
  name: string;
  /** Its label as the Salesforce UI shows it, e.g. `"Contacts"`. */
  label: string;
  /** The object the related records belong to, e.g. `"Contact"`. */
  objectName: string;
};

/** A record as a listing, search or related list reports it. */
export type SalesforceRecordSummary = {
  /** The record's 18-character Salesforce Id, accepted by `getRecord`. */
  id: string;
  /** The API name of its object, e.g. `"Account"`. */
  objectName: string;
  /** Its display name — whatever Salesforce shows as the record's title. */
  title: string;
  /**
   * A few identifying fields chosen for the object, e.g. a Contact's email and account name, so
   * a listing can be scanned without opening each record.
   */
  fields: SalesforceFieldValues;
  /** When the record was last modified, as an ISO 8601 date-time. */
  lastModifiedAt: string;
  /** Where the record lives in the Salesforce UI. */
  url: string;
};

/** Everything {@link SalesforceRecord.getDetails} reports about one record. */
export type SalesforceRecordDetails = SalesforceRecordSummary & {
  /** The record's owner. */
  owner: SalesforceUser | null;
  /** When the record was created, as an ISO 8601 date-time. */
  createdAt: string;
};

/** Which fields {@link SalesforceRecord.getDetails} should return. */
export type SalesforceRecordDetailOptions = {
  /**
   * Field API names to return, e.g. `["Name", "Industry", "Owner.Name"]`. Defaults to the
   * fields on the record's page layout.
   */
  fields?: string[];
};

/** A Salesforce user, as an owner, assignee or directory entry. */
export type SalesforceUser = {
  /** The user's 18-character Salesforce Id, accepted wherever an assignee or owner is given. */
  id: string;
  name: string;
  email: string | null;
  /** The user's login name, which is unique across all of Salesforce. */
  username: string;
  /** True when the user is active and can be assigned work. */
  isActive: boolean;
};

/** Narrows {@link SalesforceObject.listRecords}. */
export type SalesforceRecordFilter = SalesforcePageOptions & {
  /**
   * Only records whose field values all match, e.g. `{StageName: "Prospecting", OwnerId: "005..."}`.
   * Use {@link SalesforceOrg.query} for anything an equality match cannot express.
   */
  where?: SalesforceFieldValues;
  /** Only records modified at or after this ISO 8601 date-time. */
  modifiedSince?: string;
  /** Field API name to sort by. Defaults to `"LastModifiedDate"`. */
  orderBy?: string;
  /** Sort direction. Defaults to `"desc"`. */
  direction?: "asc" | "desc";
};

/** A search for records. */
export type SalesforceSearch = SalesforcePageOptions & {
  /** The text to search for. Must be at least two characters. */
  text: string;
  /**
   * On an org session, the objects to search, e.g. `["Account", "Contact"]`. Defaults to every
   * object that holds CRM data. Ignored by {@link SalesforceObject.search}, which always
   * searches its own object.
   */
  objectNames?: string[];
};

/** How many results a page should hold. */
export type SalesforcePageOptions = {
  /** Results per page, 1–200. Defaults to 50. */
  pageSize?: number;
};

/** One entry in a record's activity timeline. */
export type SalesforceActivity = {
  /** The activity's 18-character Salesforce Id. */
  id: string;
  /** What it is: a task, or a calendar event such as a meeting. */
  kind: "task" | "event";
  /** What kind of contact it records, when one was given, e.g. `"Call"` or `"Email"`. */
  type: string | null;
  subject: string;
  description: string | null;
  /** `"open"` or `"completed"` for a task; `"scheduled"` for an event. */
  status: "open" | "completed" | "scheduled";
  /** A task's due date or an event's start, as an ISO 8601 date-time. */
  date: string | null;
  /** Whose activity it is. */
  assignee: SalesforceUser | null;
  /** When it was created, as an ISO 8601 date-time. */
  createdAt: string;
};

/** The call, task or meeting to log against a record. */
export type SalesforceLogActivityOptions = {
  /** A task (the default) or a calendar event. */
  kind?: "task" | "event";
  subject: string;
  description?: string;
  /** What kind of contact it records, e.g. `"Call"` or `"Email"`. */
  type?: string;
  /** A task's due date or an event's start, as an ISO 8601 date or date-time. */
  date?: string;
  /** For an event, how long it runs. Defaults to 30. */
  durationMinutes?: number;
  /** True to log a task that already happened. Ignored for an event. */
  completed?: boolean;
  /** Whose activity it is. Defaults to the connected user. */
  assigneeId?: string;
};

/** A note attached to a record. */
export type SalesforceNote = {
  /** The note's 18-character Salesforce Id. */
  id: string;
  title: string;
  body: string;
  /** Who wrote it. */
  author: SalesforceUser | null;
  /** When it was written, as an ISO 8601 date-time. */
  createdAt: string;
};

/** The note to attach to a record. */
export type SalesforceAddNoteOptions = {
  title: string;
  body: string;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when Salesforce rejects written values — a missing required field, a picklist value
 * that does not exist, a validation rule, or a duplicate. Correct the named fields and retry.
 */
export interface SalesforceValidationError extends Error {
  /** Salesforce's error code, e.g. `"REQUIRED_FIELD_MISSING"`. */
  readonly code: string;
  /** The field API names Salesforce blamed, when it named any. */
  readonly fields: string[];
}

/**
 * Thrown when Salesforce rejects a SOQL query. The message is Salesforce's own, naming the
 * position at fault, so the query can be corrected and retried.
 */
export interface SalesforceQueryError extends Error {
  /** Salesforce's error code, e.g. `"MALFORMED_QUERY"`. */
  readonly code: string;
}
