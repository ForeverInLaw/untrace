import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useState } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: "primary" | "secondary";
}

export function Button({ kind = "secondary", className = "", type = "button", ...props }: ButtonProps) {
  return <button className={`button button--${kind} ${className}`} type={type} {...props} />;
}

interface ConfirmButtonProps extends Omit<ButtonProps, "onClick"> {
  confirmLabel: string;
  onConfirm: () => void;
}

/// Acts on the second press. The first one asks again in the button itself; moving
/// focus away or pressing Escape takes the question back.
export function ConfirmButton({ confirmLabel, onConfirm, children, ...props }: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      {...props}
      onBlur={() => setArmed(false)}
      onClick={() => {
        setArmed(!armed);
        if (armed) onConfirm();
      }}
      onKeyDown={(event) => event.key === "Escape" && setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}

type BoxProps =Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function Checkbox({ className = "", ...props }: BoxProps) {
  return <input className={`checkbox ${className}`} type="checkbox" {...props} />;
}

export function CheckboxLabel({ children, ...props }: BoxProps & { children: ReactNode }) {
  return (
    <label className="check-line">
      <input className="checkbox" type="checkbox" {...props} />
      <span>{children}</span>
    </label>
  );
}

export function Switch({ children, ...props }: BoxProps & { children: ReactNode }) {
  return (
    <label className="check-line">
      <input className="switch" type="checkbox" {...props} />
      <span>{children}</span>
    </label>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function TextField({ label, className = "", ...props }: TextFieldProps) {
  return (
    <label className={`field ${className}`}>
      <span className="field__label">{label}</span>
      <input className="input" {...props} />
    </label>
  );
}

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
}

export function TextAreaField({ label, ...props }: TextAreaFieldProps) {
  return (
    <label className="field">
      <span className="field__label field__label--hidden">{label}</span>
      <textarea className="input input--area" {...props} />
    </label>
  );
}

interface NoticeProps {
  tone: "safe" | "caution" | "fault";
  icon?: ReactNode;
  children: ReactNode;
}

export function Notice({ tone, icon, children }: NoticeProps) {
  return (
    <p className={`notice notice--${tone}`} role={tone === "fault" ? "alert" : "status"}>
      {icon}
      <span>{children}</span>
    </p>
  );
}

interface ScreenProps {
  heading?: ReactNode;
  lead?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  /// The body scrolls on its own and fills the height, for long tables.
  fill?: boolean;
  children?: ReactNode;
}

/// One working screen: heading, scrolling body and a fixed action bar.
export function Screen({ heading, lead, note, actions, fill = false, children }: ScreenProps) {
  return (
    <div className="screen">
      <div className={`screen__body ${fill ? "screen__body--fill" : ""}`}>
        {heading && <h1 className="screen__heading">{heading}</h1>}
        {lead && <p className="screen__lead">{lead}</p>}
        {children}
      </div>
      {(note || actions) && (
        <footer className="action-bar">
          <p className="action-bar__note">{note}</p>
          <div className="action-bar__actions">{actions}</div>
        </footer>
      )}
    </div>
  );
}
