import { describe, expect, it } from "vitest";
import {
  isObjectName,
  isSalesforceId,
  objectSubresourceId,
  orgSubresourceId,
  parseSalesforceSubresource,
  recordSubresourceId,
  toCaseSafeId,
} from "../src/salesforce-subresources";

const ORG = "00D5f000000AbCdEAA";
const RECORD = "0015f00000AbCdEfAA";

describe("toCaseSafeId", () => {
  it("leaves an 18-character Id alone", () => {
    expect(toCaseSafeId(ORG)).toBe(ORG);
  });

  it("appends the case-encoding suffix Salesforce defines", () => {
    // Every one of the first 15 characters upper-case encodes as bits 11111 = index 31 = "5".
    expect(toCaseSafeId("ABCDEFGHIJKLMNO")).toBe("ABCDEFGHIJKLMNO555");
    // None upper-case encodes as bits 00000 = index 0 = "A".
    expect(toCaseSafeId("abcdefghijklmno")).toBe("abcdefghijklmnoAAA");
    // A mixed example: "001D0" has one upper-case (bit 3 -> "I"), "00000" none ("A"), "Ir1gH" two
    // (bits 0 and 4 -> 17 -> "R").
    expect(toCaseSafeId("001D000000Ir1gH")).toBe("001D000000Ir1gHIAR");
  });

  it("refuses anything that is not a Salesforce Id", () => {
    expect(() => toCaseSafeId("")).toThrow();
    expect(() => toCaseSafeId("0015f00000AbCdE_")).toThrow();
    expect(() => toCaseSafeId("0015f00000AbCd")).toThrow();
  });
});

describe("subresource IDs", () => {
  it("round-trips an org", () => {
    const id = orgSubresourceId(ORG);
    expect(id).toBe(`org/${ORG}`);
    expect(parseSalesforceSubresource(id)).toEqual({ kind: "org", orgId: ORG });
  });

  it("round-trips an object", () => {
    const id = objectSubresourceId(ORG, "Account");
    expect(id).toBe(`org/${ORG}/object/Account`);
    expect(parseSalesforceSubresource(id)).toEqual({
      kind: "object", orgId: ORG, objectName: "Account",
    });
  });

  it("round-trips a record, keeping the object as its identity", () => {
    const id = recordSubresourceId(ORG, "Invoice__c", RECORD);
    expect(id).toBe(`org/${ORG}/object/Invoice__c/record/${RECORD}`);
    expect(parseSalesforceSubresource(id)).toEqual({
      kind: "record", orgId: ORG, objectName: "Invoice__c", recordId: RECORD,
    });
  });

  it("refuses an Id that is not in the case-safe form", () => {
    // A 15-character Id must be normalized first, or the same record would get two IDs.
    expect(() => orgSubresourceId("00D5f000000AbCd")).toThrow();
    expect(() => recordSubresourceId(ORG, "Account", "0015f00000AbCdE")).toThrow();
  });

  it("refuses an object name Salesforce would not accept", () => {
    expect(() => objectSubresourceId(ORG, "")).toThrow();
    expect(() => objectSubresourceId(ORG, "2Bad")).toThrow();
    expect(() => objectSubresourceId(ORG, "has space")).toThrow();
  });

  it("refuses IDs this gatekeeper never reports", () => {
    expect(() => parseSalesforceSubresource("global")).toThrow();
    expect(() => parseSalesforceSubresource(`org/${ORG}/record/${RECORD}`)).toThrow();
    expect(() => parseSalesforceSubresource(`salesforce/org/${ORG}`)).toThrow();
    expect(() => parseSalesforceSubresource(`org/${ORG}/object/Account/record/${RECORD}/field/Name`))
      .toThrow();
    expect(() => parseSalesforceSubresource(`workspace/${ORG}`)).toThrow();
  });
});

describe("shape predicates", () => {
  it("accepts only 18-character alphanumeric Ids", () => {
    expect(isSalesforceId(ORG)).toBe(true);
    expect(isSalesforceId("00D5f000000AbCd")).toBe(false);
    expect(isSalesforceId(`${ORG}X`)).toBe(false);
  });

  it("accepts object API names, standard and custom", () => {
    expect(isObjectName("Account")).toBe(true);
    expect(isObjectName("Invoice__c")).toBe(true);
    expect(isObjectName("_leading")).toBe(false);
    expect(isObjectName("9Lives")).toBe(false);
  });
});
