import "@angular/compiler"
import { setupTestBed } from "@analogjs/vitest-angular/setup-testbed"

// Zoneless, like every Angular 22 app: change detection runs on signal writes
// and events, and `fixture.detectChanges()` renders synchronously.
setupTestBed({ zoneless: true })
