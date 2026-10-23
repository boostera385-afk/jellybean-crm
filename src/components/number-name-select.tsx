import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  NUMBER_NAMES,
  formatInboxPhone,
  numberNameLabel,
} from "../../supabase/functions/_shared/quo-number-names";

/** The saved values. The list and its inbox numbers live in one shared file,
 *  so the lead card and the Quo matching cannot disagree. */
export const NUMBER_NAME_OPTIONS = NUMBER_NAMES.map((entry) => entry.name);

export function NumberNameSelect({
  value,
  onChange,
  onCommit,
  className,
  size = "default",
  placeholder = "Select number name",
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit?: (next: string) => void;
  className?: string;
  size?: "sm" | "default";
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const sizeCls = size === "sm" ? "h-8 text-[12px]" : "h-9 text-[13px]";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "w-full justify-between font-normal",
            sizeCls,
            !value && "text-muted-foreground",
            className,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="truncate">{value ? numberNameLabel(value) : placeholder}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          filter={(value, search, keywords) => {
            if (value.toLowerCase().startsWith(search.toLowerCase())) return 1;
            // Typing digits finds the inbox by its number, however it is written.
            const digits = search.replace(/\D/g, "");
            return digits.length >= 3 && keywords?.some((phone) => phone.includes(digits)) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search name or number..." className="h-9" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {/* Clear option — lets a number name be removed from the lead. */}
              <CommandItem
                value="No number name"
                onSelect={() => {
                  onChange("");
                  onCommit?.("");
                  setOpen(false);
                }}
                className="text-[12.5px] text-muted-foreground"
              >
                <Check className={cn("mr-2 h-3.5 w-3.5", !value ? "opacity-100" : "opacity-0")} />
                No number name
              </CommandItem>
              {NUMBER_NAMES.map(({ name: opt, phone }) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  keywords={phone ? [phone.replace(/\D/g, "")] : undefined}
                  // Save the name itself, never the displayed label with its
                  // number: number_name is matched to the Quo inbox by name.
                  onSelect={() => {
                    onChange(opt);
                    onCommit?.(opt);
                    setOpen(false);
                  }}
                  className="text-[12.5px]"
                >
                  <Check
                    className={cn("mr-2 h-3.5 w-3.5", value === opt ? "opacity-100" : "opacity-0")}
                  />
                  <span className="flex-1 truncate">{opt}</span>
                  {phone && (
                    <span className="ml-2 shrink-0 tabular-nums text-[11px] text-muted-foreground">
                      {formatInboxPhone(phone)}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
