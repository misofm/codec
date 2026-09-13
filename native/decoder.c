#include <FLAC/stream_decoder.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if defined(__wasm__)
#define CODEC_IMPORT(module, name) \
  __attribute__((import_module(module), import_name(name)))
#define CODEC_EXPORT(name) __attribute__((export_name(name)))
#else
#define CODEC_IMPORT(module, name)
#define CODEC_EXPORT(name)
#endif

#define CODEC_DECODER_ABI 1u
#define CODEC_OUTPUT_CAPACITY (384u * 1024u)

/*
 * Asyncify suspends the synchronous libFLAC call when the host has no bytes in
 * its single input slot. Positive values are bytes copied, zero is true EOF,
 * and a negative value aborts decoding.
 */
CODEC_IMPORT("codec", "read")
extern int32_t codec_read(uint8_t *target, uint32_t maximum_bytes);

typedef struct codec_decoder {
  FLAC__StreamDecoder *decoder;
  uint8_t output[CODEC_OUTPUT_CAPACITY];
  uint32_t output_length;
  uint32_t output_frames;
  uint64_t output_frame_offset;
  uint64_t decoded_frames;
  uint64_t decoded_bytes;
  uint64_t input_bytes;
  uint64_t expected_frames;
  uint64_t streaminfo_frames;
  uint32_t expected_sample_rate;
  uint32_t expected_channels;
  uint32_t expected_bits_per_sample;
  uint32_t sample_rate;
  uint32_t channels;
  uint32_t bits_per_sample;
  uint32_t minimum_block_frames;
  uint32_t maximum_block_frames;
  uint32_t previous_block_frames;
  uint32_t frame_number;
  uint32_t maximum_metadata_bytes;
  uint32_t singleton_metadata;
  int32_t callback_error;
  int initialized;
  int metadata_ready;
  int md5_present;
  int expected_format_present;
  int expected_frames_present;
  int standard_icon_seen;
  int file_icon_seen;
} codec_decoder;

#define CODEC_METADATA_SEEKTABLE (1u << FLAC__METADATA_TYPE_SEEKTABLE)
#define CODEC_METADATA_VORBIS_COMMENT \
  (1u << FLAC__METADATA_TYPE_VORBIS_COMMENT)
#define CODEC_METADATA_CUESHEET (1u << FLAC__METADATA_TYPE_CUESHEET)

static int is_all_zero(const uint8_t *bytes, size_t length) {
  size_t index;
  for (index = 0; index < length; index++) {
    if (bytes[index] != 0) return 0;
  }
  return 1;
}

static int string_equals(const char *left, const char *right) {
  size_t index = 0;
  while (left[index] != '\0' && right[index] != '\0') {
    if (left[index] != right[index]) return 0;
    index++;
  }
  return left[index] == right[index];
}

static FLAC__StreamDecoderReadStatus read_callback(
    const FLAC__StreamDecoder *decoder,
    FLAC__byte buffer[],
    size_t *bytes,
    void *client_data) {
  codec_decoder *self = (codec_decoder *)client_data;
  size_t maximum = *bytes;
  int32_t result;

  if (maximum == 0 || maximum > UINT32_MAX) {
    self->callback_error = 1;
    *bytes = 0;
    return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
  }

  if (FLAC__stream_decoder_get_state(decoder) ==
          FLAC__STREAM_DECODER_SEARCH_FOR_METADATA ||
      FLAC__stream_decoder_get_state(decoder) ==
          FLAC__STREAM_DECODER_READ_METADATA) {
    uint64_t remaining;
    if (self->input_bytes >= self->maximum_metadata_bytes) {
      self->callback_error = 2;
      *bytes = 0;
      return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    }
    remaining = (uint64_t)self->maximum_metadata_bytes - self->input_bytes;
    if (remaining < maximum) maximum = (size_t)remaining;
  }

  result = codec_read(buffer, (uint32_t)maximum);
  if (result > 0 && (uint32_t)result <= (uint32_t)maximum) {
    *bytes = (size_t)result;
    self->input_bytes += (uint32_t)result;
    return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
  }
  *bytes = 0;
  if (result == 0) return FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM;
  self->callback_error = 3;
  return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
}

static FLAC__StreamDecoderWriteStatus write_callback(
    const FLAC__StreamDecoder *decoder,
    const FLAC__Frame *frame,
    const FLAC__int32 *const channels[],
    void *client_data) {
  codec_decoder *self = (codec_decoder *)client_data;
  uint32_t block = frame->header.blocksize;
  uint32_t width;
  uint32_t sample;
  uint32_t channel;
  uint64_t output_bytes;
  uint64_t position;
  (void)decoder;

  if (!self->metadata_ready || self->output_length != 0 || block == 0 ||
      block > self->maximum_block_frames ||
      (self->previous_block_frames != 0 &&
       self->previous_block_frames < self->minimum_block_frames) ||
      frame->header.sample_rate != self->sample_rate ||
      frame->header.channels != self->channels ||
      frame->header.bits_per_sample != self->bits_per_sample) {
    self->callback_error = 10;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }

  if (frame->header.number_type == FLAC__FRAME_NUMBER_TYPE_SAMPLE_NUMBER) {
    position = frame->header.number.sample_number;
  } else if (frame->header.number_type == FLAC__FRAME_NUMBER_TYPE_FRAME_NUMBER) {
    if (frame->header.number.frame_number != self->frame_number ||
        (self->previous_block_frames != 0 &&
         self->previous_block_frames != self->maximum_block_frames)) {
      self->callback_error = 11;
      return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    position = self->decoded_frames;
  } else {
    self->callback_error = 11;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }

  if (position != self->decoded_frames) {
    self->callback_error = 11;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }

  width = self->bits_per_sample / 8u;
  output_bytes = (uint64_t)block * self->channels * width;
  if (output_bytes > CODEC_OUTPUT_CAPACITY ||
      (self->expected_frames_present &&
       self->decoded_frames + block > self->expected_frames)) {
    self->callback_error = 12;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }

  for (sample = 0; sample < block; sample++) {
    for (channel = 0; channel < self->channels; channel++) {
      uint32_t offset = (sample * self->channels + channel) * width;
      uint32_t value = (uint32_t)channels[channel][sample];
      self->output[offset] = (uint8_t)value;
      self->output[offset + 1] = (uint8_t)(value >> 8);
      if (width == 3u) self->output[offset + 2] = (uint8_t)(value >> 16);
    }
  }

  self->output_frame_offset = self->decoded_frames;
  self->output_length = (uint32_t)output_bytes;
  self->output_frames = block;
  self->decoded_frames += block;
  self->decoded_bytes += output_bytes;
  self->previous_block_frames = block;
  self->frame_number += 1;
  return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}

static void metadata_callback(
    const FLAC__StreamDecoder *decoder,
    const FLAC__StreamMetadata *metadata,
    void *client_data) {
  codec_decoder *self = (codec_decoder *)client_data;
  const FLAC__StreamMetadata_StreamInfo *info;
  const char *violation = NULL;
  uint32_t index;
  uint32_t singleton;
  (void)decoder;

  if (self->callback_error != 0) return;
  if (metadata->type == FLAC__METADATA_TYPE_STREAMINFO) {
    if (self->metadata_ready) {
      self->callback_error = 20;
      return;
    }
    info = &metadata->data.stream_info;
    if (info->sample_rate < 8000u || info->sample_rate > 192000u ||
        (info->channels != 1u && info->channels != 2u) ||
        (info->bits_per_sample != 16u && info->bits_per_sample != 24u) ||
        info->min_blocksize < 16u ||
        info->max_blocksize < info->min_blocksize ||
        info->max_blocksize > 65535u ||
        (info->min_framesize != 0u && info->max_framesize != 0u &&
         info->max_framesize < info->min_framesize)) {
      self->callback_error = 21;
      return;
    }
    if (self->expected_format_present &&
        (info->sample_rate != self->expected_sample_rate ||
         info->channels != self->expected_channels ||
         info->bits_per_sample != self->expected_bits_per_sample)) {
      self->callback_error = 22;
      return;
    }
    if (self->expected_frames_present && info->total_samples != 0 &&
        info->total_samples != self->expected_frames) {
      self->callback_error = 23;
      return;
    }

    self->sample_rate = info->sample_rate;
    self->channels = info->channels;
    self->bits_per_sample = info->bits_per_sample;
    self->minimum_block_frames = info->min_blocksize;
    self->maximum_block_frames = info->max_blocksize;
    self->streaminfo_frames = info->total_samples;
    self->expected_frames = self->expected_frames_present
                                ? self->expected_frames
                                : info->total_samples;
    self->expected_frames_present =
        self->expected_frames_present || info->total_samples != 0;
    self->md5_present =
        !is_all_zero(info->md5sum, sizeof(info->md5sum));
    self->metadata_ready = 1;
    return;
  }

  if (!self->metadata_ready || metadata->type >= FLAC__METADATA_TYPE_UNDEFINED) {
    self->callback_error = 20;
    return;
  }

  singleton = 0;
  if (metadata->type == FLAC__METADATA_TYPE_SEEKTABLE)
    singleton = CODEC_METADATA_SEEKTABLE;
  else if (metadata->type == FLAC__METADATA_TYPE_VORBIS_COMMENT)
    singleton = CODEC_METADATA_VORBIS_COMMENT;
  else if (metadata->type == FLAC__METADATA_TYPE_CUESHEET)
    singleton = CODEC_METADATA_CUESHEET;
  if (singleton != 0) {
    if ((self->singleton_metadata & singleton) != 0) {
      self->callback_error = 20;
      return;
    }
    self->singleton_metadata |= singleton;
  }

  switch (metadata->type) {
    case FLAC__METADATA_TYPE_PADDING:
      return;
    case FLAC__METADATA_TYPE_APPLICATION:
      if (metadata->length >= 4u) return;
      break;
    case FLAC__METADATA_TYPE_SEEKTABLE:
      if (FLAC__format_seektable_is_legal(&metadata->data.seek_table)) return;
      break;
    case FLAC__METADATA_TYPE_VORBIS_COMMENT:
      if (!FLAC__format_vorbiscomment_entry_value_is_legal(
              metadata->data.vorbis_comment.vendor_string.entry,
              metadata->data.vorbis_comment.vendor_string.length))
        break;
      for (index = 0;
           index < metadata->data.vorbis_comment.num_comments;
           index++) {
        if (!FLAC__format_vorbiscomment_entry_is_legal(
                metadata->data.vorbis_comment.comments[index].entry,
                metadata->data.vorbis_comment.comments[index].length))
          break;
      }
      if (index == metadata->data.vorbis_comment.num_comments) return;
      break;
    case FLAC__METADATA_TYPE_CUESHEET:
      if (FLAC__format_cuesheet_is_legal(&metadata->data.cue_sheet, false,
                                         &violation))
        return;
      break;
    case FLAC__METADATA_TYPE_PICTURE:
      if (!FLAC__format_picture_is_legal(&metadata->data.picture, &violation))
        break;
      if (metadata->data.picture.type ==
          FLAC__STREAM_METADATA_PICTURE_TYPE_FILE_ICON_STANDARD) {
        if (self->standard_icon_seen ||
            !string_equals(metadata->data.picture.mime_type, "image/png") ||
            metadata->data.picture.width != 32u ||
            metadata->data.picture.height != 32u)
          break;
        self->standard_icon_seen = 1;
      } else if (metadata->data.picture.type ==
                 FLAC__STREAM_METADATA_PICTURE_TYPE_FILE_ICON) {
        if (self->file_icon_seen) break;
        self->file_icon_seen = 1;
      }
      return;
    default:
      self->callback_error = 20;
      return;
  }
  self->callback_error = 21;
}

static void error_callback(
    const FLAC__StreamDecoder *decoder,
    FLAC__StreamDecoderErrorStatus status,
    void *client_data) {
  codec_decoder *self = (codec_decoder *)client_data;
  (void)decoder;
  if (self->callback_error == 0)
    self->callback_error = 100 + (int32_t)status;
}

CODEC_EXPORT("codec_decoder_abi_version")
uint32_t codec_decoder_abi_version(void) { return CODEC_DECODER_ABI; }

CODEC_EXPORT("codec_decoder_new")
codec_decoder *codec_decoder_new(
    uint32_t maximum_metadata_bytes,
    uint32_t expected_sample_rate,
    uint32_t expected_channels,
    uint32_t expected_bits_per_sample,
    uint32_t expected_frames_low,
    uint32_t expected_frames_high,
    uint32_t expected_format_present,
    uint32_t expected_frames_present) {
  codec_decoder *self;
  if (maximum_metadata_bytes < 42u) return NULL;
  self = (codec_decoder *)calloc(1, sizeof(codec_decoder));
  if (self == NULL) return NULL;
  self->decoder = FLAC__stream_decoder_new();
  if (self->decoder == NULL) {
    free(self);
    return NULL;
  }
  self->maximum_metadata_bytes = maximum_metadata_bytes;
  self->expected_sample_rate = expected_sample_rate;
  self->expected_channels = expected_channels;
  self->expected_bits_per_sample = expected_bits_per_sample;
  self->expected_frames =
      ((uint64_t)expected_frames_high << 32) | expected_frames_low;
  self->expected_format_present = expected_format_present != 0;
  self->expected_frames_present = expected_frames_present != 0;
  if (!FLAC__stream_decoder_set_md5_checking(self->decoder, true) ||
      !FLAC__stream_decoder_set_metadata_respond_all(self->decoder)) {
    FLAC__stream_decoder_delete(self->decoder);
    free(self);
    return NULL;
  }
  return self;
}

CODEC_EXPORT("codec_decoder_init")
int32_t codec_decoder_init(codec_decoder *self) {
  FLAC__StreamDecoderInitStatus status;
  if (self == NULL || self->decoder == NULL || self->initialized) return -1;
  status = FLAC__stream_decoder_init_stream(
      self->decoder,
      read_callback,
      NULL,
      NULL,
      NULL,
      NULL,
      write_callback,
      metadata_callback,
      error_callback,
      self);
  if (status != FLAC__STREAM_DECODER_INIT_STATUS_OK)
    return -10 - (int32_t)status;
  self->initialized = 1;
  if (!FLAC__stream_decoder_process_until_end_of_metadata(self->decoder) ||
      self->callback_error != 0 || !self->metadata_ready)
    return -20;
  return 0;
}

/* 1: output block, 2: true EOF, 0: progress, negative: terminal failure. */
CODEC_EXPORT("codec_decoder_process_single")
int32_t codec_decoder_process_single(codec_decoder *self) {
  FLAC__StreamDecoderState state;
  if (self == NULL || !self->initialized || self->decoder == NULL ||
      self->output_length != 0)
    return -1;
  if (!FLAC__stream_decoder_process_single(self->decoder) ||
      self->callback_error != 0)
    return -2;
  if (self->output_length != 0) return 1;
  state = FLAC__stream_decoder_get_state(self->decoder);
  return state == FLAC__STREAM_DECODER_END_OF_STREAM ? 2 : 0;
}

CODEC_EXPORT("codec_decoder_finish")
int32_t codec_decoder_finish(codec_decoder *self) {
  FLAC__bool valid;
  if (self == NULL || !self->initialized || self->decoder == NULL ||
      FLAC__stream_decoder_get_state(self->decoder) !=
          FLAC__STREAM_DECODER_END_OF_STREAM ||
      self->output_length != 0)
    return -1;
  if ((self->expected_frames_present &&
       self->decoded_frames != self->expected_frames) ||
      self->callback_error != 0)
    return -2;
  valid = FLAC__stream_decoder_finish(self->decoder);
  self->initialized = 0;
  return valid && self->callback_error == 0 ? 0 : -3;
}

CODEC_EXPORT("codec_decoder_delete")
void codec_decoder_delete(codec_decoder *self) {
  if (self == NULL) return;
  if (self->decoder != NULL) FLAC__stream_decoder_delete(self->decoder);
  memset(self, 0, sizeof(codec_decoder));
  free(self);
}

CODEC_EXPORT("codec_decoder_output_ptr")
uint32_t codec_decoder_output_ptr(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)(uintptr_t)self->output;
}

CODEC_EXPORT("codec_decoder_output_length")
uint32_t codec_decoder_output_length(codec_decoder *self) {
  return self == NULL ? 0u : self->output_length;
}

CODEC_EXPORT("codec_decoder_output_frames")
uint32_t codec_decoder_output_frames(codec_decoder *self) {
  return self == NULL ? 0u : self->output_frames;
}

CODEC_EXPORT("codec_decoder_output_frame_offset_low")
uint32_t codec_decoder_output_frame_offset_low(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)self->output_frame_offset;
}

CODEC_EXPORT("codec_decoder_output_frame_offset_high")
uint32_t codec_decoder_output_frame_offset_high(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)(self->output_frame_offset >> 32);
}

CODEC_EXPORT("codec_decoder_release_output")
void codec_decoder_release_output(codec_decoder *self) {
  if (self == NULL) return;
  self->output_length = 0;
  self->output_frames = 0;
}

CODEC_EXPORT("codec_decoder_sample_rate")
uint32_t codec_decoder_sample_rate(codec_decoder *self) {
  return self == NULL ? 0u : self->sample_rate;
}

CODEC_EXPORT("codec_decoder_channels")
uint32_t codec_decoder_channels(codec_decoder *self) {
  return self == NULL ? 0u : self->channels;
}

CODEC_EXPORT("codec_decoder_bits_per_sample")
uint32_t codec_decoder_bits_per_sample(codec_decoder *self) {
  return self == NULL ? 0u : self->bits_per_sample;
}

CODEC_EXPORT("codec_decoder_minimum_block_frames")
uint32_t codec_decoder_minimum_block_frames(codec_decoder *self) {
  return self == NULL ? 0u : self->minimum_block_frames;
}

CODEC_EXPORT("codec_decoder_maximum_block_frames")
uint32_t codec_decoder_maximum_block_frames(codec_decoder *self) {
  return self == NULL ? 0u : self->maximum_block_frames;
}

CODEC_EXPORT("codec_decoder_total_frames_low")
uint32_t codec_decoder_total_frames_low(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)self->expected_frames;
}

CODEC_EXPORT("codec_decoder_total_frames_high")
uint32_t codec_decoder_total_frames_high(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)(self->expected_frames >> 32);
}

CODEC_EXPORT("codec_decoder_total_frames_known")
uint32_t codec_decoder_total_frames_known(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)self->expected_frames_present;
}

CODEC_EXPORT("codec_decoder_streaminfo_frames_low")
uint32_t codec_decoder_streaminfo_frames_low(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)self->streaminfo_frames;
}

CODEC_EXPORT("codec_decoder_streaminfo_frames_high")
uint32_t codec_decoder_streaminfo_frames_high(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)(self->streaminfo_frames >> 32);
}

CODEC_EXPORT("codec_decoder_streaminfo_frames_known")
uint32_t codec_decoder_streaminfo_frames_known(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)(self->streaminfo_frames != 0);
}

CODEC_EXPORT("codec_decoder_md5_present")
uint32_t codec_decoder_md5_present(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)self->md5_present;
}

CODEC_EXPORT("codec_decoder_decoded_frames_low")
uint32_t codec_decoder_decoded_frames_low(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)self->decoded_frames;
}

CODEC_EXPORT("codec_decoder_decoded_frames_high")
uint32_t codec_decoder_decoded_frames_high(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)(self->decoded_frames >> 32);
}

CODEC_EXPORT("codec_decoder_decoded_bytes_low")
uint32_t codec_decoder_decoded_bytes_low(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)self->decoded_bytes;
}

CODEC_EXPORT("codec_decoder_decoded_bytes_high")
uint32_t codec_decoder_decoded_bytes_high(codec_decoder *self) {
  return self == NULL ? 0u : (uint32_t)(self->decoded_bytes >> 32);
}

CODEC_EXPORT("codec_decoder_callback_error")
int32_t codec_decoder_callback_error(codec_decoder *self) {
  return self == NULL ? -1 : self->callback_error;
}

CODEC_EXPORT("codec_decoder_state")
int32_t codec_decoder_state(codec_decoder *self) {
  return self == NULL || self->decoder == NULL
      ? -1
      : (int32_t)FLAC__stream_decoder_get_state(self->decoder);
}
