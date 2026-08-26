import { describe, expect, it } from "vitest";
import { buildSegmentQuery, type SegmentContext } from "./segments";

// The client's requirement (2026-08-26): each part of the video must show what
// THAT part's narration is about. A section about the factory process searches
// for factory footage — prepending the project subject onto a concrete b-roll
// query turns it back into a subject query and re-creates the
// every-part-shows-the-subject repetition. Generic queries still get anchored;
// that was a real failure ("Creative Controls company profile" pulled iPhone
// tutorials) and must not regress.

const context: SegmentContext = {
  mainSubject: "Dave Kindig",
  subjectAliases: ["Kindig"],
  contextTerms: ["Kindig It Design"],
};

describe("buildSegmentQuery b-roll content exception", () => {
  it("leaves a concrete b-roll content query un-anchored", () => {
    expect(buildSegmentQuery("rifle factory assembly line", context, "", "broll"))
      .toBe("rifle factory assembly line");
  });

  it("still prepends the subject onto a GENERIC b-roll query", () => {
    expect(buildSegmentQuery("company profile", context, "", "broll"))
      .toBe("Dave Kindig company profile");
  });

  it("still prepends the subject for talking_head queries", () => {
    expect(buildSegmentQuery("factory tour interview", context, "", "talking_head"))
      .toBe("Dave Kindig factory tour interview");
  });

  it("still prepends the subject when no intent type is given (legacy callers)", () => {
    expect(buildSegmentQuery("Utah court ruling 2016", context, ""))
      .toBe("Dave Kindig Utah court ruling 2016");
  });

  it("returns an already-anchored query unchanged regardless of intent", () => {
    expect(buildSegmentQuery("Kindig It Design lawsuit 2016", context, "", "broll"))
      .toBe("Kindig It Design lawsuit 2016");
  });
});
