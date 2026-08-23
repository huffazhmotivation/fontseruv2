import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

type NativeNumberProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange">;

export interface NumericInputProps extends NativeNumberProps {
  value: number;
  onChange: (value: number) => void;
  showStepper?: boolean;
}

type StepperDrag = {
  pointerId: number;
  startY: number;
  appliedDragSteps: number;
};

export const NumericInput = forwardRef<HTMLInputElement, NumericInputProps>(function NumericInput(
  { value, onChange, showStepper = true, className = "", readOnly, disabled, ...props },
  forwardedRef
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<StepperDrag | null>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

  const commitDomValue = () => {
    const next = Number(inputRef.current?.value);
    if (Number.isFinite(next)) onChange(next);
  };

  const stepBy = (direction: 1 | -1, amount = 1) => {
    const input = inputRef.current;
    if (!input || disabled || readOnly || amount <= 0) return;

    try {
      direction > 0 ? input.stepUp(amount) : input.stepDown(amount);
      commitDomValue();
    } catch {
      // `stepUp`/`stepDown` are unavailable for step="any". Fall back to a
      // numeric delta while preserving min/max constraints.
      const rawStep = Number(input.step);
      const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
      const min = input.min === "" ? -Infinity : Number(input.min);
      const max = input.max === "" ? Infinity : Number(input.max);
      const current = Number(input.value);
      if (!Number.isFinite(current)) return;
      const next = Math.min(max, Math.max(min, current + direction * step * amount));
      input.value = String(next);
      commitDomValue();
    }
  };

  const dragStepsForDistance = (distancePx: number) => {
    const distance = Math.max(0, Math.abs(distancePx) - 3);
    if (distance === 0) return 0;

    // Small movement stays precise; larger movement accelerates naturally.
    const magnitude = Math.floor(Math.pow(distance / 6, 1.22));
    return Math.sign(distancePx) * magnitude;
  };

  const beginStepperDrag = (
    e: ReactPointerEvent<HTMLButtonElement>,
    direction: 1 | -1
  ) => {
    if (disabled || readOnly || e.button !== 0) return;
    e.preventDefault();

    // A normal click changes the value immediately, without requiring the
    // numeric input to be focused first.
    stepBy(direction);

    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      appliedDragSteps: 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveStepperDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();

    // Up = positive / increase, down = negative / decrease.
    const targetDragSteps = dragStepsForDistance(drag.startY - e.clientY);
    const deltaSteps = targetDragSteps - drag.appliedDragSteps;
    if (deltaSteps === 0) return;

    stepBy(deltaSteps > 0 ? 1 : -1, Math.abs(deltaSteps));
    drag.appliedDragSteps = targetDragSteps;
  };

  const endStepperDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    inputRef.current?.focus({ preventScroll: true });
  };

  return (
    <span className="fm-numeric-control">
      <input
        {...props}
        ref={inputRef}
        type="number"
        className={className}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {showStepper && !readOnly && (
        <span className="fm-numeric-stepper" aria-hidden="false">
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onPointerDown={(e) => beginStepperDrag(e, 1)}
            onPointerMove={moveStepperDrag}
            onPointerUp={endStepperDrag}
            onPointerCancel={endStepperDrag}
            aria-label="Increase value"
          >
            <ChevronUp size={11} strokeWidth={2.25} aria-hidden="true" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onPointerDown={(e) => beginStepperDrag(e, -1)}
            onPointerMove={moveStepperDrag}
            onPointerUp={endStepperDrag}
            onPointerCancel={endStepperDrag}
            aria-label="Decrease value"
          >
            <ChevronDown size={11} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </span>
      )}
    </span>
  );
});
