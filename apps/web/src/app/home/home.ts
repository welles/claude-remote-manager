import { AppDatePipe } from '../ui/dates';
import { httpResource } from '@angular/common/http';
import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { HealthResponse } from '@claude-remote-manager/shared-types';
import { AppPageBar } from '../ui/page-bar';

@Component({
  selector: 'app-home',
  host: { class: 'app-page' },
  imports: [
    AppPageBar,
    AppDatePipe,
    MatButtonModule,
    MatCardModule,
    MatProgressBarModule,
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  protected readonly health = httpResource<HealthResponse>(() => '/api/health');
}
