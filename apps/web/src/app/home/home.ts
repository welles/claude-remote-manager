import { AppDatePipe } from '../ui/dates';
import { httpResource } from '@angular/common/http';
import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import type { HealthResponse } from '@claude-remote-manager/shared-types';

@Component({
  selector: 'app-home',
  imports: [
    AppDatePipe,
    MatButtonModule,
    MatCardModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  protected readonly health = httpResource<HealthResponse>(() => '/api/health');
}
