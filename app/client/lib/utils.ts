import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export type WithoutChildren<T> = Omit<T, "children">;
export type WithoutChild<T> = Omit<T, "child">;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends Element = Element> = T & {
  ref?: U | null;
};

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
