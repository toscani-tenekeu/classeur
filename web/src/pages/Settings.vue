<script setup lang="ts">
import { DownloadIcon, RefreshCwIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useResource } from '@/composables/useResource'
import { updateAvailable } from '@/composables/useSession'
import { api, messageOf, post } from '@/lib/api'
import { ago } from '@/lib/format'
import type { ActionResult, UpdateState } from '@/lib/types'

const { data: update, error } = useResource<UpdateState>('/update')
const checking = ref(false)
const installing = ref(false)
const restarting = ref(false)

async function check() {
  checking.value = true
  try {
    update.value = await post<UpdateState>('/update/check')
    updateAvailable.value = update.value.available
    if (update.value.error) toast.error(update.value.error)
    else if (!update.value.available) toast.success('You have the latest version.')
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  checking.value = false
}

async function setAuto(enabled: boolean) {
  try {
    update.value = await post<UpdateState>('/update/auto', { enabled })
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

async function waitForRestart() {
  restarting.value = true
  await new Promise((resolve) => setTimeout(resolve, 3000))
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await api('/session')
      window.location.reload()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  restarting.value = false
  toast.error('The panel did not come back. Check the service on the server.')
}

async function install() {
  installing.value = true
  try {
    const result = await post<ActionResult>('/update/apply')
    toast.success(result.message)
    await waitForRestart()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  installing.value = false
}

const current = ref('')
const next = ref('')
const repeat = ref('')
const passwordError = ref('')
const saving = ref(false)
const mismatch = computed(() => repeat.value.length > 0 && repeat.value !== next.value)
const canSave = computed(() => current.value && next.value.length >= 10 && next.value === repeat.value)

async function changePassword() {
  saving.value = true
  passwordError.value = ''
  try {
    await post('/password', { current: current.value, password: next.value })
    current.value = next.value = repeat.value = ''
    toast.success('Password changed. Other devices have been signed out.')
  } catch (failure) {
    passwordError.value = messageOf(failure)
  }
  saving.value = false
}
</script>

<template>
  <LoadError :message="error" />

  <Card>
    <CardHeader>
      <CardTitle>Updates</CardTitle>
      <CardDescription v-if="update">
        Version {{ update.version }}<template v-if="update.commit"> ({{ update.commit }})</template>.
        Last checked {{ ago(update.checkedAt) }}.
      </CardDescription>
    </CardHeader>
    <CardContent v-if="update" class="flex flex-col gap-4">
      <Alert v-if="!update.managed">
        <TriangleAlertIcon />
        <AlertTitle>Updates are not available for this copy</AlertTitle>
        <AlertDescription>Classeur updates itself through git. Install it with the install script to get updates here.</AlertDescription>
      </Alert>

      <template v-else>
        <Alert v-if="restarting">
          <Spinner />
          <AlertTitle>Restarting</AlertTitle>
          <AlertDescription>The new version is starting. This page reloads on its own.</AlertDescription>
        </Alert>
        <Alert v-else-if="update.available">
          <DownloadIcon />
          <AlertTitle>
            Version {{ update.latestVersion }} is available
          </AlertTitle>
          <AlertDescription>
            <ul>
              <li v-for="commit in update.commits.slice(0, 8)" :key="commit.hash">{{ commit.subject }}</li>
              <li v-if="update.commits.length > 8">and {{ update.commits.length - 8 }} more</li>
            </ul>
          </AlertDescription>
        </Alert>
        <p v-else class="text-muted-foreground text-sm">You have the latest version.</p>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel for="auto-update">Install updates automatically</FieldLabel>
            <FieldDescription>Classeur checks every six hours and installs new versions on its own.</FieldDescription>
          </FieldContent>
          <Switch id="auto-update" :model-value="update.auto" @update:model-value="setAuto" />
        </Field>
      </template>
    </CardContent>
    <CardContent v-else><Skeleton class="h-20" /></CardContent>
    <CardFooter v-if="update?.managed" class="gap-2 border-t">
      <Button v-if="update.available" :disabled="installing || restarting" @click="install">
        <Spinner v-if="installing" data-icon="inline-start" />
        <DownloadIcon v-else data-icon="inline-start" />
        {{ installing ? 'Installing…' : 'Install update' }}
      </Button>
      <Button variant="outline" :disabled="checking || installing || restarting" @click="check">
        <Spinner v-if="checking" data-icon="inline-start" />
        <RefreshCwIcon v-else data-icon="inline-start" />
        Check for updates
      </Button>
    </CardFooter>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Password</CardTitle>
      <CardDescription>Changing it signs out every other device.</CardDescription>
    </CardHeader>
    <form @submit.prevent="changePassword">
      <CardContent>
        <FieldGroup class="max-w-sm">
          <Field>
            <FieldLabel for="current">Current password</FieldLabel>
            <Input id="current" v-model="current" type="password" autocomplete="current-password" required />
          </Field>
          <Field>
            <FieldLabel for="next">New password</FieldLabel>
            <Input id="next" v-model="next" type="password" autocomplete="new-password" required minlength="10" />
            <FieldDescription>At least 10 characters.</FieldDescription>
          </Field>
          <Field :data-invalid="mismatch">
            <FieldLabel for="repeat">Repeat new password</FieldLabel>
            <Input id="repeat" v-model="repeat" type="password" autocomplete="new-password" required :aria-invalid="mismatch" />
            <FieldError v-if="mismatch">The two passwords do not match.</FieldError>
          </Field>
          <FieldError v-if="passwordError">{{ passwordError }}</FieldError>
        </FieldGroup>
      </CardContent>
      <CardFooter class="mt-6 border-t">
        <Button type="submit" :disabled="saving || !canSave">
          <Spinner v-if="saving" data-icon="inline-start" />
          Change password
        </Button>
      </CardFooter>
    </form>
  </Card>
</template>
