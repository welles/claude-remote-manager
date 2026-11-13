import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterLink, RouterOutlet } from '@angular/router';
import { LimitsIndicator } from './limits/limits-indicator';

@Component({
  imports: [
    LimitsIndicator,
    MatButtonModule,
    MatToolbarModule,
    RouterLink,
    RouterOutlet,
  ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
