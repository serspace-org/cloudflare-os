// The subresources Salesforce reads report. Every ID names the org it came from first, because one
// deployed Worker serves every org its Connected App is installed in, and an object or record name
// means nothing without it:
//   - org/<orgId>                                        the org itself, which every read on an org
//                                                        binding reports: its users may see its
//                                                        name, its object list and its user
//                                                        directory.
//   - org/<orgId>/object/<ObjectName>                    one object, reported by a read of its
//                                                        shape (describe) or of a listing, search
//                                                        or query that spans its records rather
//                                                        than naming them.
//   - org/<orgId>/object/<ObjectName>/record/<RecordId>  one record, reported by every read of its
//                                                        field values, its related lists, its
//                                                        activities or its notes.
//
// The object in a record's ID is its identity, not a further requirement: Salesforce's row-level
// sharing is what decides who may read a record, and no one holds a row without read access to its
// object. Salesforce is one product, so the IDs carry no namespace (see formatSubresourceId).
//
// Org and record IDs are normalized to their 18-character case-safe form, so the same record is
// named by one ID whichever form a caller, a URL or the API reported.

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const ORG_FRAGMENT = "org";
const OBJECT_FRAGMENT = "object";
const RECORD_FRAGMENT = "record";

/** A resource a {@link parseSalesforceSubresource} ID names. */
export type SalesforceSubresource =
  | { kind: "org"; orgId: string }
  | { kind: "object"; orgId: string; objectName: string }
  | { kind: "record"; orgId: string; objectName: string; recordId: string };

/**
 * The subresource ID of the org with Id `orgId`: `org/<orgId>`.
 * @throws Error when `orgId` is not a Salesforce Id.
 */
export function orgSubresourceId(orgId: string): string {
  return formatSubresourceId({
    fragments: [{ name: ORG_FRAGMENT, id: requireSalesforceId(orgId) }],
  });
}

/**
 * The subresource ID of object `objectName` in org `orgId`: `org/<orgId>/object/<ObjectName>`.
 * @throws Error when `orgId` is not a Salesforce Id or `objectName` is not an object API name.
 */
export function objectSubresourceId(orgId: string, objectName: string): string {
  return formatSubresourceId({
    fragments: [
      { name: ORG_FRAGMENT, id: requireSalesforceId(orgId) },
      { name: OBJECT_FRAGMENT, id: requireObjectName(objectName) },
    ],
  });
}

/**
 * The subresource ID of record `recordId` of object `objectName` in org `orgId`:
 * `org/<orgId>/object/<ObjectName>/record/<RecordId>`.
 * @throws Error when any of the three is not of its expected shape.
 */
export function recordSubresourceId(
  orgId: string,
  objectName: string,
  recordId: string,
): string {
  return formatSubresourceId({
    fragments: [
      { name: ORG_FRAGMENT, id: requireSalesforceId(orgId) },
      { name: OBJECT_FRAGMENT, id: requireObjectName(objectName) },
      { name: RECORD_FRAGMENT, id: requireSalesforceId(recordId) },
    ],
  });
}

/**
 * The resource an ID made by {@link orgSubresourceId}, {@link objectSubresourceId} or
 * {@link recordSubresourceId} names.
 * @throws Error for any other ID, including one not in canonical form.
 */
export function parseSalesforceSubresource(subresource: string): SalesforceSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [org, object, record] = fragments;
  if (namespace === undefined && org?.name === ORG_FRAGMENT && isSalesforceId(org.id)) {
    const orgId = org.id;
    if (fragments.length === 1) return { kind: "org", orgId };
    if (object.name === OBJECT_FRAGMENT && isObjectName(object.id)) {
      const objectName = object.id;
      if (fragments.length === 2) return { kind: "object", orgId, objectName };
      if (
        fragments.length === 3 &&
        record.name === RECORD_FRAGMENT &&
        isSalesforceId(record.id)
      ) {
        return { kind: "record", orgId, objectName, recordId: record.id };
      }
    }
  }
  throw new Error("Not a Salesforce subresource.");
}

/**
 * True when `value` is a Salesforce Id in the 18-character case-safe form these IDs are built
 * from. The 15-character form is not accepted; normalize it with {@link toCaseSafeId} first.
 */
export function isSalesforceId(value: string): boolean {
  return /^[A-Za-z0-9]{18}$/.test(value);
}

/**
 * True when `value` is an object API name, e.g. `Account` or `Invoice__c`. Salesforce allows
 * letters, digits and underscores, starting with a letter.
 */
export function isObjectName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,78}$/.test(value);
}

const CASE_SAFE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/**
 * The 18-character case-safe form of a Salesforce Id. Salesforce reports Ids in both forms and
 * compares them case-insensitively in its 18-character form, so every Id is normalized here
 * before it is stored, reported as a subresource, or compared.
 *
 * The three added characters encode which of the first 15 characters are upper-case, five at a
 * time, exactly as Salesforce defines the conversion.
 *
 * @throws Error when `id` is neither 15 nor 18 alphanumeric characters.
 */
export function toCaseSafeId(id: string): string {
  if (isSalesforceId(id)) return id;
  if (!/^[A-Za-z0-9]{15}$/.test(id)) throw new Error("Not a Salesforce Id.");
  let suffix = "";
  for (let chunk = 0; chunk < 3; ++chunk) {
    let bits = 0;
    for (let offset = 0; offset < 5; ++offset) {
      const char = id[chunk * 5 + offset];
      if (char >= "A" && char <= "Z") bits |= 1 << offset;
    }
    suffix += CASE_SAFE_ALPHABET[bits];
  }
  return id + suffix;
}

function requireSalesforceId(id: string): string {
  if (!isSalesforceId(id)) throw new Error("Not a case-safe Salesforce Id.");
  return id;
}

function requireObjectName(objectName: string): string {
  if (!isObjectName(objectName)) throw new Error("Not a Salesforce object API name.");
  return objectName;
}
