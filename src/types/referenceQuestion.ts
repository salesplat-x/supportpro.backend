export type ReferenceQuestionType = "text" | "yesno";

export interface ReferenceQuestion {
  key: string;
  question: string;
  type: ReferenceQuestionType;
  required: boolean;
}
