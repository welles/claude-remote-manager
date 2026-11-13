import { TextFieldModule } from '@angular/cdk/text-field';
import {
  Component,
  computed,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  ATTACHMENT_MEDIA_TYPES,
  type AttachmentDto,
} from '@claude-remote-manager/shared-types';
import { AttachmentDrafts, imageFiles } from '../attachments/attachment-drafts';
import { AttachmentsApi } from '../attachments/attachments-api';
import { DraftImages } from '../attachments/draft-images';

/** A message the user wants to send. */
export interface ComposedMessage {
  /** ID to reuse (a message that was not sent before), else `null`. */
  id: string | null;
  text: string;
  attachmentIds: string[];
}

/**
 * The input of the session view: text, images (paste, drop or pick; each
 * uploaded right away and removable) and the Send and Stop buttons.
 */
@Component({
  selector: 'app-message-composer',
  imports: [
    DraftImages,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TextFieldModule,
  ],
  templateUrl: './message-composer.html',
  styleUrl: './message-composer.scss',
})
export class MessageComposer {
  /** Text in the input box (bound to the textarea's value). */
  readonly draft = model('');
  readonly label = input('Message');
  /** Sending is not possible right now (not connected, preparing, ...). */
  readonly disabled = input(false);
  /** A turn runs: Stop is offered. */
  readonly running = input(false);
  readonly send = output<ComposedMessage>();
  readonly interrupt = output<void>();

  protected readonly images = new AttachmentDrafts(inject(AttachmentsApi));
  protected readonly accept = ATTACHMENT_MEDIA_TYPES.join(',');
  protected readonly canSend = computed(
    () =>
      !this.disabled() &&
      !this.images.busy() &&
      (this.draft().trim() !== '' || this.images.ids().length > 0),
  );
  /** ID of a message being sent again. */
  private reuseId: string | null = null;

  /** Puts a message that was not sent back into the input. */
  restore(id: string, text: string, attachments: AttachmentDto[]): void {
    this.draft.set(this.draft().trim() ? `${this.draft()}\n\n${text}` : text);
    if (attachments.length > 0) {
      // The images belong to that message: send it under its ID again.
      this.reuseId = id;
      this.images.restore(attachments);
    }
  }

  /** Empties the input after the message went out. */
  clear(): void {
    this.draft.set('');
    this.images.clear();
    this.reuseId = null;
  }

  protected submit(): void {
    if (!this.canSend()) {
      return;
    }
    this.send.emit({
      id: this.reuseId,
      text: this.draft().trim(),
      attachmentIds: this.images.ids(),
    });
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submit();
    }
  }

  protected onPaste(event: ClipboardEvent): void {
    const files = imageFiles(event.clipboardData?.items ?? null);
    if (files.length > 0) {
      event.preventDefault();
      this.images.add(files);
    }
  }

  protected onDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
    }
  }

  protected onDrop(event: DragEvent): void {
    const files = imageFiles(event.dataTransfer?.files ?? null);
    if (files.length > 0) {
      event.preventDefault();
      this.images.add(files);
    }
  }

  protected onPick(event: Event): void {
    const field = event.target as HTMLInputElement;
    this.images.add(imageFiles(field.files));
    field.value = '';
  }
}
