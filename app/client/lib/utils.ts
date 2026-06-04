import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export type WithElementRef<T> = T & {
  ref?: Element | null;
};

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
