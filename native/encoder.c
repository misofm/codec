#include <FLAC/stream_encoder.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#if defined(__wasm__)
#define CODEC_IMPORT(module, name) \
  __attribute__((import_module(module), import_name(name)))
#define CODEC_EXPORT(name) __attribute__((export_name(name)))
#else
#define CODEC_IMPORT(module, name)
#define CODEC_EXPORT(name)
#endif

/*
 * Callbacks stay synchronous. The host copies each write into a bounded staging
 * area, then drains that area through the caller's Effect sink after the Wasm
 * call returns.
 */
CODEC_IMPORT("codec", "write")
extern int codec_write(uint64_t offset, const uint8_t *bytes, uint32_t length);

CODEC_IMPORT("codec", "seek")
extern int codec_seek(uint64_t offset);

#if defined(__wasm__)
/* emmalloc asks before growing; this package promises fixed memory. */
FILE *const stdin = NULL;
FILE *const stdout = NULL;
int emscripten_resize_heap(size_t requested_size) {
  (void)requested_size;
  return 0;
}
size_t emscripten_get_heap_size(void) { return 16u * 1024u * 1024u; }
int *__errno_location(void) {
  static int codec_errno;
  return &codec_errno;
}
int fclose(FILE *stream) {
  (void)stream;
  return EOF;
}
size_t fread(void *buffer, size_t size, size_t count, FILE *stream) {
  (void)buffer;
  (void)size;
  (void)count;
  (void)stream;
  return 0;
}
size_t fwrite(const void *buffer, size_t size, size_t count, FILE *stream) {
  (void)buffer;
  (void)size;
  (void)count;
  (void)stream;
  return 0;
}
int fseeko(FILE *stream, off_t offset, int whence) {
  (void)stream;
  (void)offset;
  (void)whence;
  return -1;
}
off_t ftello(FILE *stream) {
  (void)stream;
  return (off_t)-1;
}
#endif

typedef struct codec_encoder {
  FLAC__StreamEncoder *encoder;
  uint64_t cursor;
  int initialized;
} codec_encoder;

static FLAC__StreamEncoderWriteStatus write_callback(
    const FLAC__StreamEncoder *encoder,
    const FLAC__byte buffer[],
    size_t bytes,
    unsigned samples,
    unsigned current_frame,
    void *client_data) {
  codec_encoder *self = (codec_encoder *)client_data;
  (void)encoder;
  (void)samples;
  (void)current_frame;

  if (bytes > UINT32_MAX || codec_write(self->cursor, buffer, (uint32_t)bytes) != 0)
    return FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR;

  self->cursor += (uint64_t)bytes;
  return FLAC__STREAM_ENCODER_WRITE_STATUS_OK;
}

static FLAC__StreamEncoderSeekStatus seek_callback(
    const FLAC__StreamEncoder *encoder,
    FLAC__uint64 absolute_byte_offset,
    void *client_data) {
  codec_encoder *self = (codec_encoder *)client_data;
  (void)encoder;

  if (codec_seek((uint64_t)absolute_byte_offset) != 0)
    return FLAC__STREAM_ENCODER_SEEK_STATUS_ERROR;

  self->cursor = (uint64_t)absolute_byte_offset;
  return FLAC__STREAM_ENCODER_SEEK_STATUS_OK;
}

static FLAC__StreamEncoderTellStatus tell_callback(
    const FLAC__StreamEncoder *encoder,
    FLAC__uint64 *absolute_byte_offset,
    void *client_data) {
  codec_encoder *self = (codec_encoder *)client_data;
  (void)encoder;
  *absolute_byte_offset = (FLAC__uint64)self->cursor;
  return FLAC__STREAM_ENCODER_TELL_STATUS_OK;
}

CODEC_EXPORT("codec_encoder_new")
codec_encoder *codec_encoder_new(
    uint32_t sample_rate,
    uint32_t channels,
    uint32_t bits_per_sample,
    uint32_t compression_level,
    uint32_t block_size) {
  codec_encoder *self = (codec_encoder *)calloc(1, sizeof(codec_encoder));
  if (self == NULL)
    return NULL;

  self->encoder = FLAC__stream_encoder_new();
  if (self->encoder == NULL) {
    free(self);
    return NULL;
  }

  if (!FLAC__stream_encoder_set_channels(self->encoder, channels) ||
      !FLAC__stream_encoder_set_bits_per_sample(self->encoder, bits_per_sample) ||
      !FLAC__stream_encoder_set_sample_rate(self->encoder, sample_rate) ||
      !FLAC__stream_encoder_set_compression_level(self->encoder, compression_level) ||
      !FLAC__stream_encoder_set_blocksize(self->encoder, block_size) ||
      !FLAC__stream_encoder_set_verify(self->encoder, false)) {
    FLAC__stream_encoder_delete(self->encoder);
    free(self);
    return NULL;
  }

  return self;
}

CODEC_EXPORT("codec_encoder_init")
uint32_t codec_encoder_init(codec_encoder *self) {
  FLAC__StreamEncoderInitStatus status;
  if (self == NULL || self->encoder == NULL || self->initialized)
    return (uint32_t)FLAC__STREAM_ENCODER_INIT_STATUS_ENCODER_ERROR;

  status = FLAC__stream_encoder_init_stream(
      self->encoder,
      write_callback,
      seek_callback,
      tell_callback,
      NULL,
      self);
  if (status == FLAC__STREAM_ENCODER_INIT_STATUS_OK)
    self->initialized = 1;
  return (uint32_t)status;
}

CODEC_EXPORT("codec_encoder_process_interleaved")
uint32_t codec_encoder_process_interleaved(
    codec_encoder *self,
    const FLAC__int32 pcm[],
    uint32_t frames) {
  if (self == NULL || self->encoder == NULL || !self->initialized)
    return 0;
  return FLAC__stream_encoder_process_interleaved(self->encoder, pcm, frames) ? 1 : 0;
}

CODEC_EXPORT("codec_encoder_finish")
uint32_t codec_encoder_finish(codec_encoder *self) {
  FLAC__bool ok;
  if (self == NULL || self->encoder == NULL || !self->initialized)
    return 0;
  ok = FLAC__stream_encoder_finish(self->encoder);
  self->initialized = 0;
  return ok ? 1 : 0;
}

CODEC_EXPORT("codec_encoder_state")
uint32_t codec_encoder_state(codec_encoder *self) {
  if (self == NULL || self->encoder == NULL)
    return UINT32_MAX;
  return (uint32_t)FLAC__stream_encoder_get_state(self->encoder);
}

/* Deliberately does not finish: failed/interrupted calls must not emit output. */
CODEC_EXPORT("codec_encoder_delete")
void codec_encoder_delete(codec_encoder *self) {
  if (self == NULL)
    return;
  if (self->encoder != NULL)
    FLAC__stream_encoder_delete(self->encoder);
  free(self);
}
