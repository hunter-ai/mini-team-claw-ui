import { z } from "zod";

export const lazycatPickerSubmitDetailSchema = z.union([
  z.string().trim().min(1),
  z.tuple([z.string().trim().min(1), z.array(z.string()).nullish()]),
]);

export type LazycatPickerSubmitDetail = z.infer<typeof lazycatPickerSubmitDetailSchema>;

export const lazycatEntrySchema = z.object({
  basename: z.string().optional(),
  filename: z.string().optional(),
  type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  mime: z.string().optional(),
});

export function isLazycatPickerSubmitDetail(detail: unknown): detail is LazycatPickerSubmitDetail {
  return lazycatPickerSubmitDetailSchema.safeParse(detail).success;
}

function resolveLazycatPayloadCandidate(detail: LazycatPickerSubmitDetail) {
  if (typeof detail === "string") {
    return detail;
  }

  return detail[0];
}

export function parseLazycatPickerEntries(detail: LazycatPickerSubmitDetail) {
  const payload = resolveLazycatPayloadCandidate(detail);
  const parsed = JSON.parse(payload) as unknown;
  const result = z.array(lazycatEntrySchema).safeParse(parsed);
  if (!result.success) {
    throw new Error("Lazycat picker payload is not a valid file list.");
  }

  if (result.data.length === 0) {
    throw new Error("Lazycat picker payload did not include any files.");
  }

  return result.data;
}
